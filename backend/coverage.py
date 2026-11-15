"""Which SPHEREx detectors saw a position, how many images and how many visits (task C-05).

ONE TAP query without a band filter answers for all six detectors at once: a TAP round trip is
8-30 s (docs/ARCHITECTURE.md), so six per-band queries would cost six times the wait and six
times the load on IRSA for the same rows. The answer is kept 24 h by IrsaClient and reused
(stale, and labelled so) when IRSA is down.

The home page's detector picker shows it as e.g. "D6: 45 images, 4 visits".

Static copies for the 5 demo objects (served by the frontend at /cubes/<obj>/coverage.json):
    python -m backend.coverage           # writes data/cubes/<obj>/coverage.json for every static cube
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from backend import irsa

BANDS = [f"D{i}" for i in range(1, 7)]
# Same visit rule as the cubes: images further apart than this belong to different epochs.
# Must equal data.cube.EPOCH_GAP_DAYS (checked by backend/tests/test_coverage.py); not imported
# from there because data.cube pulls in astropy (~19 s on a cold Render instance).
EPOCH_GAP_DAYS = 20
COORD_DECIMALS = 4  # as /api/cube: 0.36"

REPO = Path(__file__).resolve().parents[1]


def epochs_of(mjds: list[float], gap: float = EPOCH_GAP_DAYS) -> list[dict]:
    """Group time-sorted MJDs into visits: [{mjd_min, mjd_max, n}]."""
    out: list[dict] = []
    for m in sorted(mjds):
        if out and m - out[-1]["mjd_max"] <= gap:
            out[-1]["mjd_max"] = m
            out[-1]["n"] += 1
        else:
            out.append(dict(mjd_min=m, mjd_max=m, n=1))
    return [dict(mjd_min=round(e["mjd_min"], 4), mjd_max=round(e["mjd_max"], 4), n=e["n"]) for e in out]


def summarize(rows: list[dict]) -> list[dict]:
    """Per-detector counts for D1..D6, in order; detectors without images get n_images 0."""
    by_band: dict[str, list[float]] = {b: [] for b in BANDS}
    for r in rows:
        short = str(r["band"]).split("-")[-1]
        if short in by_band:
            by_band[short].append(float(r["mjd"]))
    out = []
    for b in BANDS:
        mjds = sorted(by_band[b])
        ep = epochs_of(mjds)
        out.append(dict(band=b, n_images=len(mjds),
                        mjd_min=round(mjds[0], 4) if mjds else None,
                        mjd_max=round(mjds[-1], 4) if mjds else None,
                        n_epochs=len(ep), epochs=ep))
    return out


def coverage(client: irsa.IrsaClient, ra: float, dec: float) -> dict:
    """Coverage of (ra, dec). Raises IrsaError only if IRSA fails and nothing was saved before."""
    ra, dec = irsa.check_coords(ra, dec)
    ra, dec = round(ra, COORD_DECIMALS), round(dec, COORD_DECIMALS)
    rows, meta = client.query_images_meta(ra, dec, None)
    bands = summarize(rows)
    return dict(center=dict(ra=ra, dec=dec), n_images=sum(b["n_images"] for b in bands), bands=bands,
                epoch_gap_days=EPOCH_GAP_DAYS,
                source=dict(archive="NASA/IPAC IRSA, SPHEREx Level 2 (TAP spherex.artifact + spherex.plane)", **meta))


def write_static(cubes_dir: Path, client: irsa.IrsaClient | None = None) -> list[Path]:
    """data/cubes/<obj>/coverage.json for every static cube, centred where its cubes are centred."""
    client = client or irsa.IrsaClient()
    written = []
    for obj_dir in sorted(p for p in Path(cubes_dir).iterdir() if p.is_dir()):
        metas = sorted(obj_dir.glob("D[1-6]/cube.json"))
        if not metas:
            continue
        centre = json.loads(metas[0].read_text(encoding="utf-8"))["center"]
        cov = coverage(client, centre["ra"], centre["dec"])
        if cov["source"]["stale"]:
            raise RuntimeError(f"{obj_dir.name}: IRSA failed and only a saved answer exists; not writing a static file")
        cov["object"] = obj_dir.name
        path = obj_dir / "coverage.json"
        path.write_text(json.dumps(cov, indent=1) + "\n", encoding="utf-8", newline="\n")
        written.append(path)
        print(f"{obj_dir.name}: " + ", ".join(f"{b['band']} {b['n_images']}/{b['n_epochs']}" for b in cov["bands"]))
    return written


if __name__ == "__main__":
    out = write_static(Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "data" / "cubes")
    print(f"wrote {len(out)} files")
