"""Tests for the precomputed measure.json files next to the static cubes (task A-07).

The first group reads only files committed to the repository, so it runs on every machine.
The last test regenerates one file from the raw cutouts and needs the pre-fetched cache.

Outside answers: Barnard's Star proper motion +10.36 arcsec/yr in declination (Gaia DR3 via IRSA,
experiments/check_objects.py); RW Aurigae and R Draconis have catalogue proper motions below
0.03 arcsec/yr (same source), i.e. zero for this instrument, so they serve as controls.
"""
import json
from pathlib import Path

import pytest

from data import measure_static

CUBES = Path(__file__).resolve().parents[1] / "data" / "cubes"
STATIC = [("barnard", "D1"), ("wise0855", "D6"), ("epsindb", "D2"), ("rwaur", "D1"), ("rdra", "D1")]
BARNARD_PM = 10.36  # arcsec/yr


def strict_load(path):
    def refuse(token):
        raise ValueError(f"{path}: {token} is not valid JSON")
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=refuse)


@pytest.fixture(scope="module")
def measures():
    return {(o, b): strict_load(CUBES / o / b / "measure.json") for o, b in STATIC}


def test_five_files_in_the_api_format(measures):
    for (obj, band), m in measures.items():
        meta = json.loads((CUBES / obj / band / "cube.json").read_text(encoding="utf-8"))
        assert (m["object"], m["band"]) == (obj, band)
        assert {"epochs", "motion", "photometry", "saturated", "source", "frames"} <= set(m)  # tasks/A.md A-07
        assert isinstance(m["photometry"], list)
        assert m["source"]["from_cache"] is True
        # measured on the very cutouts the cube was built from, at the cube centre
        assert [f["id"] for f in m["frames"]] == [f["id"] for f in meta["frames"]]
        assert (m["ra"], m["dec"]) == (meta["center"]["ra"], meta["center"]["dec"])
        for e in m["epochs"]:
            assert {"mjd", "ra", "dec", "err_arcsec"} <= set(e)  # docs/ARCHITECTURE.md, /api/measure
        if m["motion"] is not None:
            assert {"pm_ra", "pm_dec", "err"} <= set(m["motion"])
            assert m["motion"]["status"] in ("ok", "unverified")
            assert (m["motion"]["note"] == "") == (m["motion"]["status"] == "ok")


def test_barnard_moves_north_at_the_catalogue_rate(measures):
    m = measures[("barnard", "D1")]
    assert 9.0 <= m["motion"]["pm_dec"] <= 11.5
    assert m["motion"]["status"] == "ok"
    assert m["saturated"] is True  # east-west is the weak axis and the file says why


@pytest.mark.parametrize("key", [("rwaur", "D1"), ("rdra", "D1")])
def test_stars_that_do_not_move_are_not_reported_as_moving(measures, key):
    """Task A-07 asks for "motion zero within the errors" on these two stars. R Dra meets that.
    RW Aur does not in the DR1 data (+0.21 +- 0.07 arcsec/yr east, 3.0 sigma): it is a 1.49" pair
    (Gaia DR3) whose centre of light shifts as it brightens, see data/measure_static.py. The file
    must then say that this is not a confirmed motion; a bare number would mislead."""
    m = measures[key]["motion"]
    zero = all(abs(pm) <= 3 * err for pm, err in ((m["pm_ra"], m["err_ra"]), (m["pm_dec"], m["err_dec"])))
    assert zero or (m["status"] == "unverified" and "brightness changes" in m["note"])
    # and never by hiding behind the error bar: a motion like Barnard's would stand out at 3 sigma
    assert m["err_ra"] < BARNARD_PM / 3 and m["err_dec"] < BARNARD_PM / 3
    # nor is anything near a real mover: under a twentieth of Barnard's Star per axis, or within errors
    assert zero or max(abs(m["pm_ra"]), abs(m["pm_dec"])) < BARNARD_PM / 20


def test_steady_sources_keep_status_ok(measures):
    for key in (("barnard", "D1"), ("epsindb", "D2")):
        assert measures[key]["motion"]["status"] == "ok"
    assert "brightness changes" in measures[("rwaur", "D1")]["motion"]["note"]


def test_wise0855_is_not_overstated(measures):
    m = measures[("wise0855", "D6")]
    assert m["n_used"] < 0.8 * m["n_frames"]
    assert m["motion"] is None or (m["motion"]["status"] == "unverified" and "Not a confirmed measurement" in m["motion"]["note"])


def test_committed_file_is_what_the_code_produces(measures):
    # needs the raw cutouts this cube was built from; a machine that has only the other cache skips
    try:
        fresh = measure_static.measure_cube(CUBES / "barnard" / "D1")
    except FileNotFoundError as e:
        pytest.skip(str(e))
    assert fresh == measures[("barnard", "D1")]
