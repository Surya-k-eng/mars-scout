import sys, math, rasterio
from rasterio.windows import from_bounds, Window

W, S, E, N = 77.47, 18.40, 77.57, 18.50
R = 3394839.81331631
LAT1 = math.radians(15.0)
def to_xy(lon, lat):
    return (R * math.cos(LAT1) * math.radians(lon), R * math.radians(lat))

with rasterio.open(sys.argv[1]) as src:
    print("Bounds:", src.bounds, "Bands:", src.count)
    x0, y0 = to_xy(W, S)
    x1, y1 = to_xy(E, N)
    win = from_bounds(x0, y0, x1, y1, src.transform).round_offsets().round_lengths()
    win = win.intersection(Window(0, 0, src.width, src.height))
    print("Window:", win)
    data = src.read(window=win)
    names = src.descriptions
    prof = src.profile
    prof.update(driver="GTiff", height=data.shape[1], width=data.shape[2],
                transform=src.window_transform(win))
    with rasterio.open("my_area_sr.tif", "w", **prof) as dst:
        dst.write(data)
        dst.descriptions = names
print("Saved my_area_sr.tif", data.shape, round(data.nbytes / 1e6, 1), "MB")
print("\nBand list:")
for i, n in enumerate(names, 1):
    print(i, n)
