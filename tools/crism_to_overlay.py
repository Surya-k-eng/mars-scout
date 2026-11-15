#!/usr/bin/env python3
"""
crism_to_overlay.py  -  turn crism_mosaic.tif into small PNGs the browser can read.

Run from the mars-scout folder:
    pip install rasterio numpy pillow
    python3 tools/crism_to_overlay.py

Writes public/tiles/overlays/crism/
    crism.json      bbox (lon/lat, degrees east), size, and per-band scale + thresholds
    <BAND>.png      one grey PNG per band. pixel 0 = no data, 1..255 = 0..vmax

If the printed bbox is wrong (CRISM overlay lands in the wrong place on the map), pass it yourself:
    python3 tools/crism_to_overlay.py --bbox LON_WEST LAT_SOUTH LON_EAST LAT_NORTH
"""
import argparse, json, math, re
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

R_MARS = 3396190.0
# every band BuildPotentialModule.js can use (MINERALS table)
WANT = ['BD1900_2', 'BD1900R2', 'BD2100_2', 'SINDEX2', 'D2300', 'BD2290', 'BD2190', 'BD2210_2',
        'MIN2295_2480', 'MIN2345_2537', 'BD2500_2',
        'BD1750_2', 'BD2250', 'MIN2250', 'OLINDEX3', 'LCPINDEX2', 'HCPINDEX2',
        'BD530_2', 'BD640_2', 'BD860_2', 'BD920_2', 'BD1500_2', 'BD3100']

ap = argparse.ArgumentParser()
ap.add_argument('--tif', default='crism_mosaic.tif')
ap.add_argument('--bands', default='crism_mosaic_bands.txt')
ap.add_argument('--out', default='public/tiles/overlays/crism')
ap.add_argument('--max', type=int, default=4096, help='longest side of the PNGs, pixels')
ap.add_argument('--bbox', type=float, nargs=4, metavar=('LON_W', 'LAT_S', 'LON_E', 'LAT_N'))
ap.add_argument('--all', action='store_true', help='export EVERY band in the bands file (60 PNGs)')
ap.add_argument('--extra', nargs='*', default=[], help='more band names to export')
a = ap.parse_args()

# "1 R770" / "2 RBR" ... -> {name: 1-based band number}
names = {}
for line in Path(a.bands).read_text().splitlines():
    m = re.match(r'^\s*(\d+)\s+(\S+)', line)
    if m:
        names[m.group(2)] = int(m.group(1))


def bbox_degrees(src):
    b = src.bounds
    geo = False
    try:
        geo = bool(src.crs and src.crs.is_geographic)
    except Exception:
        pass
    if geo or (max(abs(b.left), abs(b.right)) <= 361 and max(abs(b.top), abs(b.bottom)) <= 91):
        return [b.left, b.bottom, b.right, b.top]
    txt = ''
    try:
        txt = src.crs.to_wkt()
    except Exception:
        pass

    def par(pats, default):
        for p in pats:
            m = re.search(p, txt, re.I)
            if m:
                return float(m.group(1))
        return default

    lon0 = par([r'central_meridian"?\s*,\s*(-?[\d.]+)', r'Longitude of natural origin"?\s*,\s*(-?[\d.]+)'], 0.0)
    lat_ts = par([r'standard_parallel_1"?\s*,\s*(-?[\d.]+)', r'Latitude of 1st standard parallel"?\s*,\s*(-?[\d.]+)'], 0.0)
    k = R_MARS * math.cos(math.radians(lat_ts))
    return [lon0 + math.degrees(b.left / k), math.degrees(b.bottom / R_MARS),
            lon0 + math.degrees(b.right / k), math.degrees(b.top / R_MARS)]


out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
meta = {'bands': {}}

with rasterio.open(a.tif) as src:
    sc = min(1.0, a.max / max(src.width, src.height))
    ow, oh = max(1, round(src.width * sc)), max(1, round(src.height * sc))
    bb = list(a.bbox) if a.bbox else bbox_degrees(src)
    meta.update(bbox=bb, width=ow, height=oh)
    print(f'mosaic {src.width}x{src.height} -> PNG {ow}x{oh}')
    print(f'bbox lon {bb[0]:.4f}..{bb[2]:.4f}  lat {bb[1]:.4f}..{bb[3]:.4f}   (Jezero site is 18.49 N, 77.40 E)')

    todo = list(names) if a.all else WANT + a.extra
    for name in todo:
        if name not in names:
            print(f'  skip {name}: not in {a.bands}')
            continue
        arr = src.read(names[name], out_shape=(oh, ow), resampling=Resampling.nearest).astype('float32')
        ok = np.isfinite(arr) & (np.abs(arr) < 1e4)           # CRISM "ignore" values are huge (e.g. 65535)
        if src.nodata is not None:
            ok &= arr != src.nodata
        ok &= arr > 0                                          # a band depth <= 0 is "nothing detected"
        pos = arr[ok]
        if pos.size < 100:
            print(f'  skip {name}: almost no detections')
            continue
        vmax = float(np.percentile(pos, 99.5))
        p80, p90, p95 = (float(v) for v in np.percentile(pos, [80, 90, 95]))
        byte = np.zeros(arr.shape, np.uint8)
        byte[ok] = np.clip(1 + arr[ok] / vmax * 254, 1, 255).astype(np.uint8)
        Image.fromarray(byte, 'L').save(out / f'{name}.png', optimize=True)
        meta['bands'][name] = {'vmax': vmax, 'p80': p80, 'p90': p90, 'p95': p95}
        print(f'  {name}: {pos.size} detections, p90={p90:.4f}, vmax={vmax:.4f}')

(out / 'crism.json').write_text(json.dumps(meta, indent=1))
print(f'done -> {out}/crism.json')
