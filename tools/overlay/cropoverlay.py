"""
cropoverlay.py: cut the global overlay GeoTIFFs down to the terrain tiles' footprint for WorldModule.js.

usage (from E:\\omega):  python cropoverlay.py <tiles_dir>
  <tiles_dir> = the folder that holds regional\\index.json and hirise\\index.json (VITE_TILES_URL / public\\tiles)

writes <tiles_dir>\\overlays\\<name>.png   8-bit grey: strength 0..255 (colour is applied in the shader)
       <tiles_dir>\\overlays\\<name>.json  bounds in degrees, 256-entry colour ramp, max alpha
"""
import json
import math
import os
import sys

import matplotlib
import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window, bounds as win_bounds, from_bounds

MAPS = [("olivine", "olivine_osp1_equ_map", "inferno"),
        ("pyroxene", "pyroxene_bd2000_equ_map", "viridis")]
ALPHA_MAX = 220            # must match alpha_max in makeoverlay.py
MARGIN_DEG = 0.5           # extra border around the regional footprint
RM, D2R = 3396190.0, math.pi / 180.0


def footprint(index_path):
    """Same maths as WorldModule.loadLayer: bbox/pixelSize may be metres or degrees."""
    idx = json.load(open(index_path))
    f = 1 / RM / D2R if abs(idx["bbox"][0]) > 400 or abs(idx["bbox"][3]) > 400 else 1.0
    res = abs(idx["pixelSize"]) * f
    lon0, lat0 = idx["bbox"][0] * f, idx["bbox"][3] * f
    w, n = lon0, lat0
    e = lon0 + (idx["srcWidth"] - 1) * res
    s = lat0 - (idx["srcHeight"] - 1) * res
    if w > 180:                                  # 0..360 -> -180..180 (the overlay uses -180..180)
        w, e = w - 360, e - 360
    return w, e, s, n


def main(tiles, layer="regional"):
    w, e, s, n = footprint(os.path.join(tiles, layer, "index.json"))
    w, e, s, n = w - MARGIN_DEG, e + MARGIN_DEG, max(s - MARGIN_DEG, -90), min(n + MARGIN_DEG, 90)
    print(f"footprint + margin  W/E/S/N: {w:.4f} {e:.4f} {s:.4f} {n:.4f}")
    out = os.path.join(tiles, "overlays")
    os.makedirs(out, exist_ok=True)

    for name, stem, cmap in MAPS:
        with rasterio.open(f"{stem}.tif") as src:
            win = from_bounds(w, s, e, n, src.transform)
            c0, r0 = max(int(math.floor(win.col_off)), 0), max(int(math.floor(win.row_off)), 0)
            c1 = min(int(math.ceil(win.col_off + win.width)), src.width)
            r1 = min(int(math.ceil(win.row_off + win.height)), src.height)
            if c1 <= c0 or r1 <= r0:
                raise SystemExit(f"{name}: footprint is outside the overlay raster")
            win = Window(c0, r0, c1 - c0, r1 - r0)
            alpha = src.read(4, window=win)                       # alpha = strength * ALPHA_MAX
            west, south, east, north = win_bounds(win, src.transform)

        t = np.clip(np.rint(alpha.astype("float32") / ALPHA_MAX * 255), 0, 255).astype("uint8")
        Image.fromarray(t, "L").save(os.path.join(out, f"{name}.png"), optimize=True)

        lut = (matplotlib.colormaps[cmap](np.linspace(0, 1, 256))[:, :3] * 255).round().astype(int)
        meta = {"west": west, "east": east, "south": south, "north": north,
                "alphaMax": ALPHA_MAX / 255, "lut": lut.flatten().tolist()}
        json.dump(meta, open(os.path.join(out, f"{name}.json"), "w"))
        print(f"{name}: {t.shape[1]}x{t.shape[0]} px  bounds W/E/S/N: {west:.4f} {east:.4f} {south:.4f} {north:.4f}"
              f"  deg/px {(east - west) / t.shape[1]:.4f}")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else "regional")
