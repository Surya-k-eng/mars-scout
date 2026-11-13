import sys, numpy as np, rasterio

if len(sys.argv) < 2:
    sys.exit("Usage: python read_crism.py FILE.tif [BAND_NUMBER_FOR_PREVIEW_PNG]")

path = sys.argv[1]
with rasterio.open(path) as src:
    print(f"{path}: {src.width} x {src.height} px, {src.count} bands, dtype {src.dtypes[0]}")
    print(f"Bounds (W,S,E,N): {src.bounds.left:.5f}, {src.bounds.bottom:.5f}, "
          f"{src.bounds.right:.5f}, {src.bounds.top:.5f}")
    print(f"CRS: {src.crs.to_string()[:80]}")
    print(f"nodata tag: {src.nodata}\n")
    data = src.read().astype("float32")
    names = list(src.descriptions)

# Treat the tagged nodata, NaN, and the CRISM 65535-style fill as invalid
bad = ~np.isfinite(data) | (data > 1e4)
data[bad] = np.nan

print(f"{'#':>3}  {'band':<14} {'valid%':>7} {'min':>10} {'max':>10} {'mean':>10}")
for i in range(data.shape[0]):
    b = data[i]
    valid = np.isfinite(b)
    nm = names[i] if i < len(names) and names[i] else "-"
    if valid.any():
        print(f"{i+1:>3}  {nm:<14} {valid.mean()*100:>6.0f}% "
              f"{np.nanmin(b):>10.4f} {np.nanmax(b):>10.4f} {np.nanmean(b):>10.4f}")
    else:
        print(f"{i+1:>3}  {nm:<14} {0:>6}%   (all invalid)")

if len(sys.argv) > 2:
    k = int(sys.argv[2])
    b = data[k - 1]
    lo, hi = np.nanpercentile(b, [2, 98])
    img = np.clip((b - lo) / (hi - lo + 1e-12), 0, 1)
    import matplotlib.pyplot as plt
    plt.imsave(f"band{k}.png", img, cmap="viridis")
    print(f"\nSaved band{k}.png (stretched {lo:.4f}..{hi:.4f})")