#!/usr/bin/env python3
"""
ti_to_overlay.py  -  cut a thermal inertia map down to your area and turn it into a PNG the browser can read.

Run from the mars-scout folder (same python as crism_to_overlay.py):
    python3 tools/ti_to_overlay.py --tif path/to/thermal_inertia.tif

It crops to the CRISM area (read from public/tiles/overlays/crism/crism.json) plus a margin, so a huge
global mosaic is fine. Or give the area yourself:  --bbox LON_W LAT_S LON_E LAT_N

Writes public/tiles/overlays/ti/ti.png + ti.json   (pixel 0 = no data, 1..255 = 0..vmax, units tiu)
If the file stores scaled numbers (e.g. TI x 10) use --scale 0.1
"""
import argparse, json, math, re
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window, from_bounds

R_MARS = 3396190.0

ap = argparse.ArgumentParser()
ap.add_argument('--tif', required=True)
ap.add_argument('--out', default='public/tiles/overlays/ti')
ap.add_argument('--like', default='public/tiles/overlays/crism/crism.json', help='take the area from this json')
ap.add_argument('--bbox', type=float, nargs=4, metavar=('LON_W', 'LAT_S', 'LON_E', 'LAT_N'))
ap.add_argument('--pad', type=float, default=0.25, help='margin around the area, degrees')
ap.add_argument('--band', type=int, default=1)
ap.add_argument('--scale', type=float, default=1.0, help='multiply raw values by this to get tiu')
ap.add_argument('--max', type=int, default=2048, help='longest side of the PNG, pixels')
a = ap.parse_args()

if a.bbox:
    want = list(a.bbox)
else:
    want = json.loads(Path(a.like).read_text())['bbox']
want = [want[0] - a.pad, want[1] - a.pad, want[2] + a.pad, want[3] + a.pad]

with rasterio.open(a.tif) as src:
    b = src.bounds
    geo = False
    try:
        geo = bool(src.crs and src.crs.is_geographic)
    except Exception:
        pass
    geo = geo or (max(abs(b.left), abs(b.right)) <= 361 and max(abs(b.top), abs(b.bottom)) <= 91)

    lon0, k = 0.0, R_MARS
    if geo:
        w, s, e, n = want
        if b.right > 180 and w < 0:      # the file uses 0..360 east longitudes
            w, e = w + 360, e + 360
        if b.left < 0 and w > 180:       # the file uses -180..180
            w, e = w - 360, e - 360
        win = from_bounds(w, s, e, n, src.transform)
    else:                                # projected, metres (equirectangular)
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
        w, s, e, n = want
        win = from_bounds(math.radians(w - lon0) * k, math.radians(s) * R_MARS,
                          math.radians(e - lon0) * k, math.radians(n) * R_MARS, src.transform)

    win = win.round_offsets().round_lengths()
    try:
        win = win.intersection(Window(0, 0, src.width, src.height))
    except Exception:
        raise SystemExit('The thermal inertia file does not cover your area. Check --bbox and the file.')
    if win.width < 1 or win.height < 1:
        raise SystemExit('The thermal inertia file does not cover your area. Check --bbox and the file.')

    sc = min(1.0, a.max / max(win.width, win.height))
    ow, oh = max(1, round(win.width * sc)), max(1, round(win.height * sc))
    arr = src.read(a.band, window=win, out_shape=(oh, ow), resampling=Resampling.nearest).astype('float32') * a.scale
    L, B, R, T = src.window_bounds(win)
    if geo:
        bbox = [L, B, R, T]
    else:
        bbox = [lon0 + math.degrees(L / k), math.degrees(B / R_MARS), lon0 + math.degrees(R / k), math.degrees(T / R_MARS)]

    ok = np.isfinite(arr) & (np.abs(arr) < 1e5) & (arr > 0)
    if src.nodata is not None:
        ok &= (arr != src.nodata * a.scale)
    pos = arr[ok]
    if pos.size < 10:
        raise SystemExit('No valid thermal inertia values inside the area.')
    vmax = float(np.percentile(pos, 99.5))
    byte = np.zeros(arr.shape, np.uint8)
    byte[ok] = np.clip(1 + arr[ok] / vmax * 254, 1, 255).astype(np.uint8)

out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
Image.fromarray(byte, 'L').save(out / 'ti.png', optimize=True)
meta = {'bbox': bbox, 'width': ow, 'height': oh, 'vmax': vmax, 'unit': 'tiu'}
(out / 'ti.json').write_text(json.dumps(meta, indent=1))

p = lambda q: float(np.percentile(pos, q))
print(f'PNG {ow}x{oh}, bbox lon {bbox[0]:.4f}..{bbox[2]:.4f} lat {bbox[1]:.4f}..{bbox[3]:.4f}')
print(f'thermal inertia (tiu): min {pos.min():.0f}  p10 {p(10):.0f}  median {p(50):.0f}  p90 {p(90):.0f}  max {pos.max():.0f}')
print('share of area:  <150 dust %.0f%%   150-250 sand %.0f%%   250-400 crust %.0f%%   >400 rock %.0f%%' % tuple(
    100 * np.mean(m) for m in (pos < 150, (pos >= 150) & (pos < 250), (pos >= 250) & (pos < 400), pos >= 400)))
print(f'done -> {out}/ti.json')
