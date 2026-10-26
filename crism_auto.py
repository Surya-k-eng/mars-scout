import sys, os, re, math, requests, rasterio
from rasterio.windows import from_bounds, Window

if len(sys.argv) < 3:
    sys.exit("Usage: python crism_auto.py LAT LON [HALF_SIZE_DEG]")
lat, lon = float(sys.argv[1]), float(sys.argv[2])
half = float(sys.argv[3]) if len(sys.argv) > 3 else 0.05
W, S, E, N = lon - half, lat - half, lon + half, lat + half

def find_files(o):
    if isinstance(o, dict):
        if "Product_file" in o:
            pf = o["Product_file"]
            yield from (pf if isinstance(pf, list) else [pf])
        for v in o.values():
            yield from find_files(v)
    elif isinstance(o, list):
        for v in o:
            yield from find_files(v)

def window_for(src):
    wkt = src.crs.to_wkt()
    R = float(re.search(r'SPHEROID\["[^"]*",([\d.]+)', wkt).group(1))
    p1 = float(re.search(r'standard_parallel_1",([\d.\-]+)', wkt).group(1))
    f = lambda lo, la: (R * math.cos(math.radians(p1)) * math.radians(lo), R * math.radians(la))
    x0, y0 = f(W, S); x1, y1 = f(E, N)
    full = from_bounds(x0, y0, x1, y1, src.transform)
    try:
        inter = full.intersection(Window(0, 0, src.width, src.height))
    except Exception:
        return None, 0.0
    cov = (inter.width * inter.height) / (full.width * full.height)
    return inter.round_offsets().round_lengths(), cov

def download(url, path):
    have = os.path.getsize(path) if os.path.exists(path) else 0
    h = {"Range": f"bytes={have}-"} if have else {}
    r = requests.get(url, headers=h, stream=True, timeout=60)
    if r.status_code == 416:
        return
    r.raise_for_status()
    mode = "ab" if r.status_code == 206 else "wb"
    total = int(r.headers.get("content-length", 0)) + (have if mode == "ab" else 0)
    done = have if mode == "ab" else 0
    with open(path, mode) as fh:
        for chunk in r.iter_content(1 << 20):
            fh.write(chunk); done += len(chunk)
            print(f"\r  {done/1e6:.0f} / {total/1e6:.0f} MB", end="", flush=True)
    print()

print(f"Box: lat {S:.3f}..{N:.3f}, lon {W:.3f}..{E:.3f}")
q = ("https://oderest.rsl.wustl.edu/live2?query=products&target=mars&ihid=MRO&iid=CRISM&pt=MTRDR&loc=b"
     f"&minlat={S}&maxlat={N}&westernlon={W}&easternlon={E}&results=f&output=JSON")
files = list(find_files(requests.get(q, timeout=120).json()))
cands = sorted((f for f in files if f["FileName"].upper().endswith(".IMG")
                and re.search(r"_SR\d", f["FileName"].upper())), key=lambda f: int(f["KBytes"]))
print(f"{len(cands)} summary-parameter (SR) products found")

best = None
for f in cands:
    try:
        with rasterio.open("/vsicurl/" + f["URL"]) as src:
            win, cov = window_for(src)
    except Exception as e:
        print("  skip", f["FileName"], e); continue
    print(f"  {f['FileName']}  {int(f['KBytes'])/1000:.0f} MB  coverage {cov*100:.0f}%")
    if win is not None and cov >= 0.95:
        best = f; break
if best is None:
    sys.exit("No SR product fully covers this box. Try a smaller HALF_SIZE.")

obs = best["FileName"].split("_")[0].lower()
os.makedirs("cache", exist_ok=True)
img = f"cache/{obs}_sr.img"; hdr = f"cache/{obs}_sr.hdr"
print("Using", best["FileName"])
download(best["URL"], img)
download(best["URL"].rsplit(".", 1)[0] + ".hdr", hdr)

names = []
m = re.search(r"band names\s*=\s*\{(.*?)\}", open(hdr).read(), re.S | re.I)
if m:
    names = [n.strip() for n in m.group(1).replace("\n", " ").split(",")]

with rasterio.open(img) as src:
    win, cov = window_for(src)
    data = src.read(window=win)
    prof = src.profile
    prof.update(driver="GTiff", height=data.shape[1], width=data.shape[2],
                transform=src.window_transform(win))
    out = f"{obs}_area.tif"
    with rasterio.open(out, "w", **prof) as dst:
        dst.write(data)
        if len(names) == data.shape[0]:
            dst.descriptions = names
open(f"{obs}_bands.txt", "w").write("\n".join(f"{i} {n}" for i, n in enumerate(names, 1)))
print(f"\nSaved {out}  shape={data.shape}  {data.nbytes/1e6:.1f} MB")
print(f"Band names in {obs}_bands.txt")
