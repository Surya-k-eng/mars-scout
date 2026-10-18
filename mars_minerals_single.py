#!/usr/bin/env python3
"""
mars_minerals_single.py - ONE file. Finds CRISM mineral signals inside a
lat/lon box on Mars, downloading only the part of the big file you need
(HTTP Range requests), so you get real band-depth values without 600 MB.

Setup (once):   pip install numpy
Usage:          python mars_minerals_single.py MINLAT MAXLAT WESTLON EASTLON
Example:        python mars_minerals_single.py 21.0 21.5 74.0 74.5

Options:
  --list-only   just list the observations found
  --pick N      use observation number N (default: smallest file)
  --full        download the whole file instead of a partial one
  --step N      CSV keeps every Nth flagged pixel (default 3)

Longitudes are 0-360 east.
"""
import argparse
import csv
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request

import numpy as np

ODE = "https://oderest.rsl.wustl.edu/live2/"
UA = {"User-Agent": "mars-scout/0.1"}

# label: (band name in the SU file, rough threshold, what it suggests)
# Thresholds are ROUGH STARTING VALUES - tune them for your area.
INDICATORS = {
    "Olivine":                 ("OLINDEX3", 0.05, "olivine (OLINDEX3)"),
    "Low-Ca pyroxene":         ("LCPINDEX2", 0.03, "low-calcium pyroxene (LCPINDEX2)"),
    "High-Ca pyroxene":        ("HCPINDEX2", 0.03, "high-calcium pyroxene (HCPINDEX2)"),
    "Fe/Mg clay":              ("BD2300", 0.02, "Fe/Mg phyllosilicate (BD2300)"),
    "Al clay / hydr. silica":  ("BD2210_2", 0.02, "Al-OH phyllosilicate / hydrated silica (BD2210_2)"),
    "Hydrated minerals":       ("BD1900_2", 0.02, "any hydrated mineral (BD1900_2)"),
    "Gypsum-like sulfate":     ("BD1750_2", 0.02, "gypsum / alunite-type sulfate (BD1750_2)"),
    "Carbonate":               ("BD2500_2", 0.02, "carbonate (BD2500_2)"),
}

DTYPES = {1: "u1", 2: "i2", 3: "i4", 4: "f4", 5: "f8", 12: "u2", 13: "u4"}


# ------------------------------------------------------------ ODE query
def query_ode(minlat, maxlat, west, east, limit):
    params = dict(query="product", target="mars", results="f", ihid="MRO",
                  iid="CRISM", pt="MTRDR", loc="f", minlat=minlat,
                  maxlat=maxlat, westernlon=west, easternlon=east,
                  limit=limit, output="JSON")
    url = ODE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode("utf-8"))
    res = data["ODEResults"]
    if res.get("Status") != "Success":
        sys.exit("ODE returned: " + json.dumps(res)[:500])
    prods = res.get("Products", {}).get("Product", [])
    if isinstance(prods, dict):
        prods = [prods]
    return prods


def as_list(x):
    return x if isinstance(x, list) else [x]


def find_su_products(prods):
    out = []
    for p in prods:
        files = as_list(p["Product_files"]["Product_file"])
        byname = {f["FileName"].upper(): f for f in files}
        for name, f in byname.items():
            if re.search(r"_SU\d+[A-Z]_MTR\d\.IMG$", name):
                stem = name[:-4]
                hdr, lbl = byname.get(stem + ".HDR"), byname.get(stem + ".LBL")
                if hdr and lbl:
                    out.append(dict(obs=name[:11], stem=stem,
                                    size_mb=float(f["KBytes"]) / 1024,
                                    img=f["URL"], hdr=hdr["URL"], lbl=lbl["URL"]))
    return out


# ------------------------------------------------------------ downloading
def download(url, dest):
    """Plain full download (used for the small .HDR / .LBL files)."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"  already have {os.path.basename(dest)}")
        return

    def hook(blocks, bs, total):
        if total > 0:
            pct = min(100, blocks * bs * 100 / total)
            print(f"\r  downloading {os.path.basename(dest)}  {pct:5.1f}%", end="")
    print()
    urllib.request.urlretrieve(url, dest, hook)
    print()


def head_size(url):
    req = urllib.request.Request(url, method="HEAD", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"])


def fetch_range(url, a, b):
    """Return bytes a .. b-1 of the remote file."""
    req = urllib.request.Request(url, headers={**UA, "Range": f"bytes={a}-{b-1}"})
    with urllib.request.urlopen(req, timeout=600) as r:
        if r.status != 206:
            sys.exit("Server ignored the Range request, so partial download "
                     "isn't possible here. Re-run with --full.")
        want = b - a
        chunks, got = [], 0
        while True:
            c = r.read(1024 * 256)
            if not c:
                break
            chunks.append(c)
            got += len(c)
            print(f"\r  downloading part  {got/1e6:6.1f} / {want/1e6:.1f} MB", end="", flush=True)
        print()
        return b"".join(chunks)


# ------------------------------------------------------------ parsers
def parse_envi_hdr(path):
    txt = open(path, errors="ignore").read()
    hdr = {}
    for m in re.finditer(r"^\s*([A-Za-z_][A-Za-z0-9_ ]*?)\s*=\s*(\{.*?\}|[^\n]*)",
                         txt, re.S | re.M):
        key, val = m.group(1).strip().lower(), m.group(2).strip()
        if val.startswith("{"):
            val = [v.strip() for v in val.strip("{}").replace("\n", " ").split(",")]
        hdr[key] = val
    return hdr


def pds_num(txt, key):
    m = re.search(rf"^\s*{key}\s*=\s*([-+]?[0-9.]+(?:[eE][-+]?\d+)?)", txt, re.M)
    return float(m.group(1)) if m else None


def parse_projection(lbl_path):
    txt = open(lbl_path, errors="ignore").read()
    keys = ["MAP_RESOLUTION", "CENTER_LATITUDE", "CENTER_LONGITUDE",
            "LINE_PROJECTION_OFFSET", "SAMPLE_PROJECTION_OFFSET"]
    vals = {k: pds_num(txt, k) for k in keys}
    missing = [k for k, v in vals.items() if v is None]
    if missing:
        sys.exit("Could not find these keywords in the label: " + ", ".join(missing)
                 + "\nOpen " + lbl_path + " and tell me what the map projection "
                 "section looks like.")
    return vals


# ------------------------------------------------------------ partial download
def get_data_partial(s, folder, bbox, full):
    """Download header, label, and (part of) the big image. Returns paths."""
    hdr_p = os.path.join(folder, os.path.basename(s["hdr"]))
    lbl_p = os.path.join(folder, os.path.basename(s["lbl"]))
    img_p = os.path.join(folder, os.path.basename(s["img"]))
    download(s["hdr"], hdr_p)
    download(s["lbl"], lbl_p)

    if full:
        download(s["img"], img_p)
        return img_p, hdr_p, lbl_p

    minlat, maxlat, west, east = bbox
    h, pr = parse_envi_hdr(hdr_p), parse_projection(lbl_p)
    S, L, B = int(h["samples"]), int(h["lines"]), int(h["bands"])
    item = np.dtype(DTYPES[int(h["data type"])]).itemsize
    offset = int(h.get("header offset", "0"))
    il = h["interleave"].lower()
    names = [n.strip().upper() for n in h.get("band names", [])]

    res, off_l = pr["MAP_RESOLUTION"], pr["LINE_PROJECTION_OFFSET"]
    i0 = max(int(math.floor(off_l - res * maxlat)), 0)
    i1 = min(int(math.ceil(off_l - res * minlat)), L)
    if i0 >= i1:
        sys.exit("This observation does not overlap your box.")

    wanted = [names.index(b.upper()) for b, _, _ in INDICATORS.values()
              if b.upper() in names]
    if il == "bil":
        ranges = [(offset + i0 * B * S * item, offset + i1 * B * S * item)]
    elif il == "bip":
        ranges = [(offset + i0 * S * B * item, offset + i1 * S * B * item)]
    elif il == "bsq":
        ranges = [(offset + (b * L + i0) * S * item, offset + (b * L + i1) * S * item)
                  for b in wanted]
    else:
        sys.exit("Unknown interleave: " + il)

    mb = sum(b - a for a, b in ranges) / 1e6
    print(f"Interleave {il}: downloading {mb:.0f} MB instead of {s['size_mb']:.0f} MB")

    # empty file of the full size; only the needed byte ranges get filled in
    total = head_size(s["img"])
    with open(img_p, "wb") as f:
        f.truncate(total)
        for a, b in ranges:
            f.seek(a)
            f.write(fetch_range(s["img"], a, b))
    return img_p, hdr_p, lbl_p


# ------------------------------------------------------------ analysis
def analyze(img, hdr_path, lbl_path, bbox, step, csv_path):
    minlat, maxlat, west, east = bbox
    h = parse_envi_hdr(hdr_path)
    pr = parse_projection(lbl_path)
    S, L, B = int(h["samples"]), int(h["lines"]), int(h["bands"])
    res = pr["MAP_RESOLUTION"]
    clat, clon = pr["CENTER_LATITUDE"], pr["CENTER_LONGITUDE"]
    off_l, off_s = pr["LINE_PROJECTION_OFFSET"], pr["SAMPLE_PROJECTION_OFFSET"]
    cosc = math.cos(math.radians(clat))

    names = [n.strip().upper() for n in h.get("band names", [])]
    if not names:
        sys.exit("The header has no 'band names', so I can't tell which band is which.")

    j0 = int(math.floor(off_s + res * cosc * (west - clon)))
    j1 = int(math.ceil(off_s + res * cosc * (east - clon)))
    i0 = int(math.floor(off_l - res * maxlat))
    i1 = int(math.ceil(off_l - res * minlat))
    j0, j1 = max(j0, 0), min(j1, S)
    i0, i1 = max(i0, 0), min(i1, L)
    if j0 >= j1 or i0 >= i1:
        print("This observation does not overlap your box.")
        return
    print(f"\nYour box is rows {i0}-{i1}, cols {j0}-{j1} of this observation.")

    order = ">" if int(h.get("byte order", "0")) == 1 else "<"
    dtype = np.dtype(order + DTYPES[int(h["data type"])])
    offset = int(h.get("header offset", "0"))
    il = h["interleave"].lower()
    if il == "bil":
        cube = np.memmap(img, dtype, "r", offset, shape=(L, B, S))
        get = lambda b: cube[i0:i1, b, j0:j1]
    elif il == "bsq":
        cube = np.memmap(img, dtype, "r", offset, shape=(B, L, S))
        get = lambda b: cube[b, i0:i1, j0:j1]
    elif il == "bip":
        cube = np.memmap(img, dtype, "r", offset, shape=(L, S, B))
        get = lambda b: cube[i0:i1, j0:j1, b]
    else:
        sys.exit("Unknown interleave: " + il)

    ii, jj = np.meshgrid(np.arange(i0, i1), np.arange(j0, j1), indexing="ij")
    lat = (off_l - ii) / res
    lon = clon + (jj - off_s) / (res * cosc)
    inbox = (lat >= minlat) & (lat <= maxlat) & (lon >= west) & (lon <= east)

    rows_out = []
    print("\n=== Mineral indicators inside your box ===")
    for label, (band, thr, desc) in INDICATORS.items():
        if band.upper() not in names:
            print(f"- {label}: band {band} not in this file (skipped)")
            continue
        a = np.asarray(get(names.index(band.upper())), dtype=np.float32)
        valid = np.isfinite(a) & (a < 60000) & inbox
        nvalid = int(valid.sum())
        hit = valid & (a > thr)
        n = int(hit.sum())
        if nvalid == 0:
            print(f"- {label}: no valid pixels in the box")
            continue
        if n == 0:
            print(f"- {label}: not detected (threshold {thr})")
            continue
        la, lo, va = lat[hit], lon[hit], a[hit]
        k = int(np.argmax(va))
        print(f"- {label}: DETECTED in {n} px ({100*n/nvalid:.1f}% of valid pixels)\n"
              f"    suggests: {desc}\n"
              f"    flagged area: lat {la.min():.4f} to {la.max():.4f}, "
              f"lon {lo.min():.4f} to {lo.max():.4f}\n"
              f"    centre of flagged pixels: lat {la.mean():.4f}, lon {lo.mean():.4f}\n"
              f"    strongest: lat {la[k]:.4f}, lon {lo[k]:.4f}, value {va[k]:.4f}")
        for x in range(0, n, max(1, step)):
            rows_out.append((label, round(float(la[x]), 5), round(float(lo[x]), 5),
                             round(float(va[x]), 5)))

    with open(csv_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["mineral_indicator", "lat", "lon", "value"])
        w.writerows(rows_out)
    print(f"\nSaved {len(rows_out)} flagged points to {csv_path}")
    print("\nNote: these are spectral indicators, not proof. Thresholds are rough "
          "defaults; a 'detection' means a matching absorption feature, and "
          "dust, ice and noise can mimic it.")


# ------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("minlat", type=float)
    ap.add_argument("maxlat", type=float)
    ap.add_argument("west", type=float)
    ap.add_argument("east", type=float)
    ap.add_argument("--pick", type=int, help="observation number (default: smallest file)")
    ap.add_argument("--list-only", action="store_true")
    ap.add_argument("--full", action="store_true", help="download the whole file")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--step", type=int, default=3, help="CSV: keep every Nth flagged pixel")
    ap.add_argument("--folder", default="crism_data")
    a = ap.parse_args()
    bbox = (a.minlat, a.maxlat, a.west, a.east)

    su = find_su_products(query_ode(*bbox, a.limit))
    if not su:
        sys.exit("No CRISM observations with summary-parameter files found for that box.\n"
                 "Try a bigger box or a different area (CRISM coverage is patchy).")
    print(f"Found {len(su)} CRISM observation(s):")
    for n, s in enumerate(su):
        print(f"  [{n}] {s['obs']}  full file {s['size_mb']:.0f} MB")
    if a.list_only:
        return

    pick = a.pick if a.pick is not None else min(range(len(su)), key=lambda i: su[i]["size_mb"])
    s = su[pick]
    print(f"\nUsing [{pick}] {s['obs']}")

    folder = os.path.join(a.folder, f"{s['obs']}_{a.minlat}_{a.maxlat}_{a.west}_{a.east}")
    os.makedirs(folder, exist_ok=True)
    img, hdr, lbl = get_data_partial(s, folder, bbox, a.full)
    analyze(img, hdr, lbl, bbox, a.step,
            os.path.join(folder, f"{s['obs']}_minerals.csv"))


if __name__ == "__main__":
    main()