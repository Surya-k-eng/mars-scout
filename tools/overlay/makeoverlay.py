"""
makeoverlay.py: PDS3 Mars equirectangular IMG -> transparent RGBA overlay (PNG + GeoTIFF).

- POOL = 1 keeps full native resolution (14400x7200). POOL = 2 or 4 shrinks with max-pool (keeps peaks).
- exact percentiles from an int16 histogram (no giant float arrays)
- colorizing in row blocks, 256-entry LUT
- georeferenced on the Mars sphere: GeoTIFF plus .pgw/.prj sidecars
"""
import re
import numpy as np
import matplotlib
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

try:
    import rasterio
    from rasterio.crs import CRS
    from rasterio.enums import ColorInterp
    from rasterio.transform import from_origin
except ImportError:
    rasterio = None

SENT = np.iinfo("i2").min   # -32768, internal "missing" marker
BLOCK = 1024                # source rows per chunk (must be divisible by POOL)


# ---------- label ----------
def read_label(path):
    d = {}
    with open(path, encoding="latin-1") as f:
        for line in f:
            line = line.split("/*")[0]
            m = re.match(r"\s*(\w+)\s*=\s*(.+?)\s*$", line)
            if m:
                d.setdefault(m.group(1), m.group(2))
    return d


def num(d, key):
    """Numeric value of a label keyword, ignoring <UNIT> tags and quotes."""
    return float(re.sub(r"<[^>]*>|\"", "", d[key]).split()[0])


# ---------- raster ----------
def load_pooled(raw, miss, pool):
    """int16 array with missing -> SENT; max-pooled by `pool` in the int domain (pool=1: no pooling)."""
    H, W = raw.shape
    out = np.empty((H // pool, W // pool), "i2")
    for r in range(0, H, BLOCK):
        c = np.asarray(raw[r:r + BLOCK])
        if miss != SENT:
            c = np.where(c == miss, SENT, c)
        if pool > 1:
            h = c.shape[0]
            c = c.reshape(h // pool, pool, W // pool, pool).max(axis=(1, 3))
        out[r // pool:r // pool + c.shape[0]] = c
    return out


def hist_percentiles(p, pcts):
    """Exact percentiles of the valid int16 values, via a 65536-bin histogram."""
    counts = np.zeros(65536, np.int64)
    for r in range(0, p.shape[0], BLOCK):
        c = p[r:r + BLOCK]
        c = c[c != SENT]
        counts += np.bincount(c.astype(np.int32) + 32768, minlength=65536)
    cum = np.cumsum(counts)
    total = cum[-1]
    out = []
    for q in pcts:
        i = int(np.searchsorted(cum, q / 100.0 * total))
        out.append(min(i, 65535) - 32768)
    return out


def colorize(p, scale, off, cmap, lo, hi, alpha_max):
    lut = (matplotlib.colormaps[cmap](np.linspace(0, 1, 256)) * 255).round().astype("uint8")
    rgba = np.empty(p.shape + (4,), "uint8")
    span = max(hi - lo, 1e-12)
    for r in range(0, p.shape[0], BLOCK):
        c = p[r:r + BLOCK]
        ok = c != SENT
        v = c.astype("float32") * scale + off
        t = np.where(ok, np.clip((v - lo) / span, 0, 1), 0).astype("float32")
        blk = lut[(t * 255 + 0.5).astype("uint8")]
        blk[..., 3] = (t * alpha_max).astype("uint8")   # weak signal -> transparent
        rgba[r:r + c.shape[0]] = blk
    return rgba


# ---------- georeferencing ----------
def mars_wkt(radius_m):
    return (f'GEOGCS["Mars sphere",DATUM["Mars_sphere",SPHEROID["Mars_sphere",{radius_m},0]],'
            'PRIMEM["Reference_Meridian",0],UNIT["degree",0.0174532925199433]]')


def georef(name, d, rgba, pool):
    H2, W2 = rgba.shape[:2]
    px = pool / num(d, "MAP_RESOLUTION")                # deg/pixel
    west = num(d, "WESTERNMOST_LONGITUDE")
    north = num(d, "MAXIMUM_LATITUDE")
    wkt = mars_wkt(num(d, "A_AXIS_RADIUS") * 1000.0)

    with open(f"{name}.pgw", "w") as f:                 # world file: CENTER of top-left pixel
        f.write(f"{px}\n0\n0\n{-px}\n{west + px / 2}\n{north - px / 2}\n")
    with open(f"{name}.prj", "w") as f:
        f.write(wkt)

    if rasterio is not None:
        with rasterio.open(f"{name}.tif", "w", driver="GTiff", height=H2, width=W2, count=4,
                           dtype="uint8", crs=CRS.from_wkt(wkt),
                           transform=from_origin(west, north, px, px),
                           compress="deflate", tiled=True, BIGTIFF="IF_SAFER") as dst:
            dst.write(np.moveaxis(rgba, -1, 0))
            dst.colorinterp = [ColorInterp.red, ColorInterp.green,
                               ColorInterp.blue, ColorInterp.alpha]
    else:
        print("  rasterio not installed -> skipped GeoTIFF (pip install rasterio)")

    print(f"  size: {W2}x{H2}  deg/px: {px}")
    print(f"  bounds W/E/S/N: {west} {west + W2 * px} {north - H2 * px} {north}")


# ---------- main ----------
def make(name, cmap, lo_pct=80, hi_pct=99.7, fixed=None, alpha_max=220, pool=1):
    """fixed=(lo, hi) in physical units overrides percentiles (reproducible/comparable maps)."""
    assert pool >= 1 and BLOCK % pool == 0
    d = read_label(f"{name}.lbl")
    H, W = int(num(d, "LINES")), int(num(d, "LINE_SAMPLES"))
    assert H % pool == 0 and W % pool == 0, "dimensions not divisible by pool"
    assert int(num(d, "SAMPLE_BITS")) == 16, "expected 16-bit data"
    assert num(d, "MAP_RESOLUTION") > 0

    scale, off = num(d, "SCALING_FACTOR"), num(d, "OFFSET")
    assert scale > 0, "pooling before scaling needs a positive scale"
    miss = int(num(d, "MISSING_CONSTANT"))
    dt = "<i2" if d["SAMPLE_TYPE"].strip('"') == "LSB_INTEGER" else ">i2"

    raw = np.memmap(f"{name}.img", dtype=dt, mode="r", shape=(H, W))
    p = load_pooled(raw, miss, pool)

    if fixed:
        lo, hi = fixed
    else:
        ilo, ihi = hist_percentiles(p, [lo_pct, hi_pct])
        lo, hi = ilo * scale + off, ihi * scale + off

    rgba = colorize(p, scale, off, cmap, lo, hi, alpha_max)
    Image.fromarray(rgba).save(f"{name}.png", optimize=False, compress_level=6)
    print(f"{name}: lo/hi = {lo:.6g} / {hi:.6g}")
    georef(name, d, rgba, pool)


if __name__ == "__main__":
    make("olivine_osp1_equ_map", "inferno", 80, 99.7, pool=1)
    make("pyroxene_bd2000_equ_map", "viridis", 80, 99.7, pool=1)