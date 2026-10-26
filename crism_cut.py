import sys, math, rasterio
from rasterio.windows import from_bounds, Window

W, S, E, N = 77.47, 18.40, 77.57, 18.50
R = 3394839.81331631
LAT1 = math.radians(15.0)

def to_xy(lon, lat):
    return (R * math.cos(LAT1) * math.radians(lon), R * math.radians(lat))

url = sys.argv[1]
with rasterio.open("/vsicurl/" + url) as src:
    x0, y0 = to_xy(W, S)
    x1, y1 = to_xy(E, N)
    win = from_bounds(x0, y0, x1, y1, src.transform)
    win = win.round_offsets().round_lengths()
    win = win.intersection(Window(0, 0, src.width, src.height))
    print("Window:", win)
    bands = list(range(1, min(220, src.count) + 1))
    data = src.read(bands, window=win)
    prof = src.profile
    prof.update(driver="GTiff", height=data.shape[1], width=data.shape[2],
                count=len(bands), transform=src.window_transform(win))
    with rasterio.open("my_area.tif", "w", **prof) as dst:
        dst.write(data)
print("Saved my_area.tif", data.shape, round(data.nbytes / 1e6, 1), "MB")
