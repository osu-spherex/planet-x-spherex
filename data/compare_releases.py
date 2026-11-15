"""Compare two caches of the same exposures: quick releases (QR2/QR3) against DR1 (task A-06).

IRSA switched the SPHEREx archive to Data Release 1 on 2026-11-14 (GitHub issue #7). The demo
cache was fetched on 2026-11-10 from the quick releases. This script measures what changed for
the five demo objects, exposure by exposure, and prints the numbers quoted in docs/DR1_VS_QR.md.

An exposure is recognised by the start of its file name, e.g. `level2_2025W35_1A_0432_4D1_spx`;
the rest of the name is the processing version (`l2b-v20-2025-269` or `l2b-v27-2026-230`).

Usage:  python -m data.compare_releases [--old DIR] [--new DIR]
"""
import argparse
import csv
import sys
import warnings
from pathlib import Path

import numpy as np

from data import cube, motion, photometry

# object key, detector, and the position to measure (cutout centre unless noted)
TARGETS = [
    ("barnard", "D1", 269.4464, 4.7666, "Barnard's Star"),      # position used by tests/test_known_motion.py
    ("barnard", "D1", 269.43868, 4.78653, "static Gaia star"),  # comparison star 1.28' away
    ("epsindb", "D2", 331.09709, -56.80134, "eps Ind B"),
    ("wise0855", "D6", 133.76037, -7.2418, "WISE 0855"),
    ("rwaur", "D1", 76.95609, 30.40112, "RW Aur"),
    ("rdra", "D1", 248.16723, 66.75503, "R Dra"),
]
CUBES = [("barnard", "D1"), ("wise0855", "D6"), ("epsindb", "D2"), ("rwaur", "D1"), ("rdra", "D1")]


def exposure(name):
    return name.split("_spx")[0]


def rows(cache, obj, band):
    with open(Path(cache) / "manifest.csv", newline="", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r["object"] == obj and r["band"] == f"SPHEREx-{band}"]


def compare_cubes(old, new):
    print("\n## Cubes: same exposures, pixel by pixel\n")
    print("| cube | frames old / new | exposures in both | identical file | reprocessed | background new-old, MJy/sr "
          "| noise new/old | bright pixels new/old | max wavelength change, um |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for obj, band in CUBES:
        mo, do = cube.build_cube(obj, band, old)
        mn, dn = cube.build_cube(obj, band, new)
        io = {exposure(f["id"]): i for i, f in enumerate(mo["frames"])}
        both = [(io[exposure(f["id"])], j) for j, f in enumerate(mn["frames"]) if exposure(f["id"]) in io]
        same = [(i, j) for i, j in both if mo["frames"][i]["id"] == mn["frames"][j]["id"]]
        redo = [(i, j) for i, j in both if mo["frames"][i]["id"] != mn["frames"][j]["id"]]
        dbg, rnoise, rbright, dlam = [], [], [], []
        for i, j in redo:
            fo, fn = mo["frames"][i], mn["frames"][j]
            dbg.append(fn["bg"] - fo["bg"])
            rnoise.append(fn["noise"] / fo["noise"])
            dlam.append(abs(fn["lam_um"] - fo["lam_um"]))
            a, b = do[i], dn[j]
            bright = np.isfinite(a) & np.isfinite(b) & (a > 20 * fo["noise"])
            if bright.sum() >= 5:
                rbright.append(float(np.median(b[bright] / a[bright])))

        def med(v, fmt):
            return "-" if not v else f"{np.median(v):{fmt}} ({np.percentile(v, 16):{fmt}} .. {np.percentile(v, 84):{fmt}})"
        print(f"| {obj} {band} | {len(mo['frames'])} / {len(mn['frames'])} | {len(both)} | {len(same)} | {len(redo)} "
              f"| {med(dbg, '+.3f')} | {med(rnoise, '.3f')} | {med(rbright, '.3f')} | {max(dlam) if dlam else 0:.5f} |")
        print(f"<!-- {obj} {band} releases old {mo['source']['releases']} new {mn['source']['releases']} -->")


def compare_motion(old, new):
    print("\n## Motion (data.motion), arcsec/yr\n")
    print("| source | cache | images used | epochs | pm_ra | pm_dec | first->last dRA, dDec, arcsec | years |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for obj, band, ra, dec, label in TARGETS[:4]:
        for name, cache in (("old", old), ("new", new)):
            r = motion.measure_shift(ra, dec, band, cache)
            m = r["motion"]
            if m is None:
                print(f"| {label} {band} | {name} | {r['n_used']}/{r['n_frames']} | {len(r['epochs'])} | - | - | - | - |")
                continue
            print(f"| {label} {band} | {name} | {r['n_used']}/{r['n_frames']} | {len(r['epochs'])} "
                  f"| {m['pm_ra']:+.2f} +- {m['err_ra']:.2f} | {m['pm_dec']:+.2f} +- {m['err_dec']:.2f} "
                  f"| {r['dra_arcsec']:+.2f} +- {r['err_dra']:.2f}, {r['ddec_arcsec']:+.2f} +- {r['err_ddec']:.2f} | {r['years']:.2f} |")


def compare_photometry(old, new):
    print("\n## Photometry (data.photometry): the same exposure in both caches\n")
    print("| source | method | images old / new | reprocessed exposures measured in both | flux new/old: median (16% .. 84%) "
          "| by epoch |")
    print("| --- | --- | --- | --- | --- | --- |")
    curves = {}
    for obj, band, ra, dec, label in [TARGETS[1], TARGETS[4], TARGETS[5]]:
        res = {name: photometry.measure(ra, dec, band, cache) for name, cache in (("old", old), ("new", new))}
        po = {exposure(p["id"]): p for p in res["old"]["photometry"] if p["ok"]}
        ratios, by_epoch = [], {}
        for p in res["new"]["photometry"]:
            q = po.get(exposure(p["id"]))
            if p["ok"] and q and q["id"] != p["id"] and q["flux"] > 0:
                ratios.append(p["flux"] / q["flux"])
                by_epoch.setdefault(p["epoch"], []).append(p["flux"] / q["flux"])
        ep = ", ".join(f"e{e}: {np.median(v):.3f} (n={len(v)})" for e, v in sorted(by_epoch.items()))
        stat = "-" if not ratios else f"{np.median(ratios):.3f} ({np.percentile(ratios, 16):.3f} .. {np.percentile(ratios, 84):.3f})"
        print(f"| {label} {band} | {res['new']['photometry_method']} | {sum(p['ok'] for p in res['old']['photometry'])} / "
              f"{sum(p['ok'] for p in res['new']['photometry'])} | {len(ratios)} | {stat} | {ep} |")
        curves[label] = res
    print("\n## Light curves in both caches\n")
    for label, lam in (("RW Aur", 0.75), ("RW Aur", 0.77), ("R Dra", 0.95), ("R Dra", 0.97)):
        for name in ("old", "new"):
            r = curves[label][name]
            c = next((c for c in r["light_curves"] if c["lam_min"] <= lam < c["lam_max"]), None)
            pts = "no curve" if c is None else "  ".join(f"{p['mjd']:.0f}: {p['flux']:.2f}" for p in c["points"])
            print(f"- {label}, {lam - 0.01:.2f}-{lam + 0.01:.2f} um, {name} [{r['photometry_unit']}]: {pts}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--old", type=Path, default=cube.cache_dir(), help="quick-release cache (default: data/cache)")
    ap.add_argument("--new", type=Path, help="DR1 cache (default: data/cache_dr1 next to the old one)")
    args = ap.parse_args(argv)
    new = args.new or args.old.parent / "cache_dr1"
    warnings.simplefilter("ignore", RuntimeWarning)
    print(f"old cache: {args.old}\nnew cache: {new}")
    compare_cubes(args.old, new)
    compare_motion(args.old, new)
    compare_photometry(args.old, new)
    return 0


if __name__ == "__main__":
    sys.exit(main())
