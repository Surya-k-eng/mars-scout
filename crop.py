"""Crop a THEMIS thermal-inertia GeoTIFF to the Jezero window and write an 8-bit PNG for the viewer.

Replaces these GDAL commands (no GDAL / QGIS install needed):
    gdalinfo tile.tif
    gdal_translate -projwin 4560000 1125000 4615000 1070000 tile.tif themis_ti_jezero.tif
    gdal_translate -of PNG -ot Byte -scale themis_ti_jezero.tif public\\tiles\\themis\\ti.png

Setup (once):   pip install rasterio pillow numpy
Run:            python themis_crop.py path\\to\\your_themis_ti.tif
Options:        --window ULX ULY LRX LRY   (same order as gdal -projwin, in the raster's own units)
                --tif OUT.tif   --png OUT.png   --lo 2 --hi 98 (stretch percentiles)
"""
import argparse
import os
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import from_bounds

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument("src", help="the THEMIS thermal-inertia GeoTIFF (the 'tile.tif' of the instructions)")
p.add_argument("--window", nargs=4, type=float, default=[4560000, 1125000, 4615000, 1070000],
               metavar=("ULX", "ULY", "LRX", "LRY"))
p.add_argument("--tif", default="themis_ti_jezero.tif")
p.add_argument("--png", default=os.path.join("public", "tiles", "themis", "ti.png"))
p.add_argument("--lo", type=float, default=2.0, help="low stretch percentile")
p.add_argument("--hi", type=float, default=98.0, help="high stretch percentile")
a = p.parse_args()

ulx, uly, lrx, lry = a.window

with rasterio.open(a.src) as ds:
    # ---- what gdalinfo would tell you ----
    b = ds.bounds
    print(f"CRS        : {ds.crs}")
    print(f"pixel size : {ds.res[0]} x {ds.res[1]}")
    print(f"extent     : x {b.left} .. {b.right}   y {b.bottom} .. {b.top}")
    print(f"size       : {ds.width} x {ds.height} px, {ds.count} band(s), dtype {ds.dtypes[0]}, nodata {ds.nodata}")

    if lrx <= b.left or ulx >= b.right or uly <= b.bottom or lry >= b.top:
        sys.exit("\nThe crop window does not overlap this raster. Compare it with the extent above "
                 "(is the raster in the same coordinate system as your HiRISE index.json?).")

    # ---- crop (same as -projwin) ----
    win = from_bounds(ulx, lry, lrx, uly, ds.transform).round_offsets().round_lengths()
    data = ds.read(1, window=win, boundless=True, masked=True)
    transform = ds.window_transform(win)
    nodata = ds.nodata if ds.nodata is not None else -9999.0

    os.makedirs(os.path.dirname(os.path.abspath(a.tif)), exist_ok=True)
    with rasterio.open(a.tif, "w", driver="GTiff", height=data.shape[0], width=data.shape[1], count=1,
                       dtype="float32", crs=ds.crs, transform=transform, nodata=nodata) as out:
        out.write(data.astype("float32").filled(nodata), 1)
    print(f"\nwrote {a.tif}   ({data.shape[1]} x {data.shape[0]} px)")

# ---- 8-bit PNG with percentile stretch (same job as -ot Byte -scale, but robust to outliers) ----
valid = data.compressed()
if valid.size == 0:
    sys.exit("No valid pixels inside the window.")
lo, hi = np.percentile(valid, [a.lo, a.hi])
img = np.clip((data.astype("float32").filled(lo) - lo) / max(float(hi - lo), 1e-9), 0.0, 1.0)
png = (img * 255.0 + 0.5).astype("uint8")

os.makedirs(os.path.dirname(os.path.abspath(a.png)), exist_ok=True)
Image.fromarray(png).save(a.png)
print(f"wrote {a.png}")
print(f"PNG value 0 = {lo:.3f}, 255 = {hi:.3f}   (keep these two numbers if the viewer shows a legend)")
if valid.size < data.size:
    print(f"note: {data.size - valid.size} px had no data and are black in the PNG")