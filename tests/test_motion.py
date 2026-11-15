"""Tests for data/motion.py (task A-03) that run offline, from the pre-fetched cache.

The acceptance tests with outside answers are in tests/test_known_motion.py (owned by humans).
These add what that file does not cover: the per-epoch output, the proper-motion fit, the
saturation warning and the entry point for the backend. Skipped on machines without the cache.

Outside answers used:
  * Barnard's Star proper motion -0.80, +10.36 arcsec/yr (Gaia DR3 via IRSA, experiments/check_objects.py).
  * Static Gaia DR3 star at RA 269.43868, Dec 4.78653: proper motion 6 mas/yr (tests/test_known_motion.py).
"""
import json

import pytest

from data import cube, motion

CACHE = cube.cache_dir()
pytestmark = pytest.mark.skipif(
    not (CACHE / "manifest.csv").exists(),
    reason=f"no SPHEREx cache at {CACHE} (run experiments/prefetch_cache.py or set OSU_CACHE_DIR)")

BARNARD = (269.4464, 4.7666)
STATIC = (269.43868, 4.78653)


@pytest.fixture(scope="module")
def barnard():
    return motion.measure_shift(*BARNARD)


@pytest.fixture(scope="module")
def static():
    return motion.measure_shift(*STATIC)


def test_result_is_json_and_comes_from_the_cache(barnard):
    json.dumps(barnard, allow_nan=False)
    assert barnard["source"]["from_cache"] is True
    assert barnard["band"] == "D1"
    assert barnard["n_frames"] == 60
    assert {"epoch", "mjd", "n", "ra", "dec", "dra_arcsec", "ddec_arcsec", "err_arcsec"} <= set(barnard["epochs"][0])
    assert {"pm_ra", "pm_dec", "err"} <= set(barnard["motion"])  # docs/ARCHITECTURE.md, /api/measure


def test_barnard_proper_motion_matches_the_catalogue(barnard):
    m = barnard["motion"]
    assert len(barnard["epochs"]) == 4
    # north-south is the well-measured axis: within 1 arcsec/yr of +10.36
    assert m["pm_dec"] == pytest.approx(10.36, abs=1.0)
    # east-west is the axis hurt by the saturated core; it must still agree within its own error bar
    assert abs(m["pm_ra"] - (-0.80)) < 3 * m["err_ra"]
    assert abs(m["pm_dec"] - 10.36) < 3 * m["err_dec"]
    assert m["err_ra"] < 2.0 and m["err_dec"] < 2.0  # an error bar wide enough to hide anything proves nothing


def test_saturated_core_is_reported(barnard, static):
    assert barnard["saturated"] is True
    assert static["saturated"] is False


def test_static_star_stays_put_in_every_epoch(static):
    assert static["n_used"] == static["n_frames"] == 60
    assert len(static["epochs"]) == 4
    for e in static["epochs"]:
        assert abs(e["dra_arcsec"]) < 0.5 and abs(e["ddec_arcsec"]) < 0.5
    m = static["motion"]
    assert abs(m["pm_ra"]) < 0.5 and abs(m["pm_dec"]) < 0.5


def test_from_files_is_the_backend_entry_point():
    files = motion.cached_files(*STATIC, "D1")
    assert len(files) == 60
    r = motion.measure_shift_from_files(files[:25], *STATIC)
    json.dumps(r, allow_nan=False)
    assert r["n_frames"] == 25 and r["band"] is None


def test_nothing_to_measure_gives_no_motion_instead_of_an_error():
    # WISE 0855 in D1 (0.75-1.1 um): a 250 K brown dwarf emits nothing there, so there is no source
    # to fit. D1 is not cached for it, so use the cached D5 files and a blank spot 40" off instead.
    files = motion.cached_files(133.76037, -7.2418, "D5")
    assert files
    r = motion.measure_shift_from_files(files, 133.76037, -7.2418 - 40 / 3600)
    json.dumps(r, allow_nan=False)
    assert r["n_used"] < r["n_frames"]
    if len(r["epochs"]) < 2:
        assert r["motion"] is None and r["ddec_arcsec"] is None
