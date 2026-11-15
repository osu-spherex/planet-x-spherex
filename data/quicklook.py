"""Quick-look picture of a cube written by data/cube.py: first epoch, last epoch, difference.

Reads cube.json + cube.f32 the same way the browser does, so it also shows that the files are
self-describing. For the human check of a cube ("is the object in the centre, does it move?").

Usage:  python -m data.quicklook barnard D1 [--cube-dir DIR]   ->  <cube dir>/quicklook.png
"""
import argparse
import json
import sys
import warnings
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from data.cube import REPO, short_band


def load_cube(cube_dir):
    cube_dir = Path(cube_dir)
    meta = json.loads((cube_dir / "cube.json").read_text(encoding="utf-8"))
    data = np.fromfile(cube_dir / meta["data_url"], dtype="<f4").reshape(meta["shape"])
    return meta, data


def epoch_median(meta, data, epoch):
    sel = np.array([f["epoch"] == epoch for f in meta["frames"]])
    with warnings.catch_warnings():  # grid corners no cutout covers stay NaN
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(data[sel], axis=0)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("object")
    ap.add_argument("band")
    ap.add_argument("--cube-dir", type=Path)
    args = ap.parse_args(argv)
    band = short_band(args.band)
    cube_dir = args.cube_dir or REPO / "data" / "cubes" / args.object / band
    meta, data = load_cube(cube_dir)

    first, last = meta["epochs"][0], meta["epochs"][-1]
    a, b = epoch_median(meta, data, first["epoch"]), epoch_median(meta, data, last["epoch"])
    noise = float(np.nanmedian([f["noise"] for f in meta["frames"] if f["noise"] is not None]))
    half = meta["shape"][2] * meta["pixscale_arcsec"] / 2
    extent = [half, -half, -half, half]  # east to the left, north up; origin="upper" keeps row 0 on top
    vmax = max(float(np.nanpercentile(np.concatenate([a.ravel(), b.ravel()]), 99.5)), 10 * noise)
    panels = [
        (a, f"first epoch (median of {first['n']})\nMJD {first['mjd_min']:.0f}-{first['mjd_max']:.0f}",
         dict(cmap="gray", vmin=-2 * noise, vmax=vmax)),
        (b, f"last epoch (median of {last['n']})\nMJD {last['mjd_min']:.0f}-{last['mjd_max']:.0f}",
         dict(cmap="gray", vmin=-2 * noise, vmax=vmax)),
        (b - a, "last - first", dict(cmap="RdBu_r", vmin=-vmax / 2, vmax=vmax / 2)),
    ]
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.6), constrained_layout=True)
    for ax, (img, title, kw) in zip(axes, panels):
        cmap = plt.get_cmap(kw.pop("cmap")).copy()
        cmap.set_bad("tab:purple")  # NaN: outside the cutout or masked (saturated) pixels
        im = ax.imshow(img, origin="upper", extent=extent, interpolation="nearest", cmap=cmap, **kw)
        ax.plot([0], [0], "+", color="tab:green", ms=14, mew=1.2)  # cube centre
        ax.set_title(title, fontsize=10)
        ax.set_xlabel('east offset ["]')
        fig.colorbar(im, ax=ax, shrink=0.85, label=meta["bunit"])
    axes[0].set_ylabel('north offset ["]')
    fig.suptitle(f"{meta['object']} {meta['band']}: {meta['shape'][0]} frames, {len(meta['epochs'])} epochs, "
                 f"centre RA {meta['center']['ra']:.5f} Dec {meta['center']['dec']:.5f}  "
                 f"(SPHEREx via IRSA, from cache; purple = no valid data)", fontsize=10)
    out = cube_dir / "quicklook.png"
    fig.savefig(out, dpi=110)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
