"""Tests for the blank-sky control cube next to WISE 0855 (GitHub issue #21).

They read only files committed to the repository, so they run on every machine.

What makes it a control, and where the numbers come from:
  * same exposures as the WISE 0855 D6 cube, so noise and time sampling match;
  * centred 215" away on a spot chosen from CatWISE2020 and Gaia DR3 (data/control_cube.py);
  * and, checked here on the pixels themselves, nothing significant within 30" of its centre,
    while the WISE 0855 cube has a clear source there in the very same kind of image.
"""
import json
import math
import warnings
from pathlib import Path

import numpy as np
import pytest

CUBES = Path(__file__).resolve().parents[1] / "data" / "cubes"
CONTROL = CUBES / "wise0855_control" / "D6"
TARGET = CUBES / "wise0855" / "D6"
INNER_PX = 10  # 30 arcsec: the region the velocity search looks at


def load(folder):
    meta = json.loads((folder / "cube.json").read_text(encoding="utf-8"))
    return meta, np.fromfile(folder / meta["data_url"], dtype="<f4").reshape(meta["shape"])


def exposure(frame_id):
    return frame_id.split("_spx")[0]


def brightest_near_centre(data):
    """Brightest pixel within INNER_PX of the centre of the all-frame median, in robust sigma of that image."""
    with warnings.catch_warnings():  # grid corners no cutout covers stay NaN
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(data, axis=0)
    level = np.nanmedian(med)
    sigma = 1.4826 * np.nanmedian(np.abs(med - level))
    yy, xx = np.indices(med.shape)
    c = (med.shape[0] - 1) / 2
    inner = np.hypot(xx - c, yy - c) <= INNER_PX
    return float(np.nanmax((med[inner] - level) / sigma))


@pytest.fixture(scope="module")
def control():
    return load(CONTROL)


@pytest.fixture(scope="module")
def target():
    return load(TARGET)


def test_same_format_as_the_demo_cubes(control):
    meta, data = control
    assert (meta["object"], meta["band"]) == ("wise0855_control", "D6")
    assert meta["shape"] == [len(meta["frames"]), 61, 61] and data.shape == tuple(meta["shape"])
    assert meta["pixscale_arcsec"] == 3.0
    assert meta["source"]["from_cache"] is True
    assert meta["control"]["of"] == "wise0855"
    for f in meta["frames"]:
        assert {"id", "band", "mjd", "lam_um", "noise", "nan_frac", "epoch"} <= set(f)
    mjds = [f["mjd"] for f in meta["frames"]]
    assert mjds == sorted(mjds)


def test_same_exposures_as_the_wise0855_cube(control, target):
    ours = [exposure(f["id"]) for f in control[0]["frames"]]
    theirs = {exposure(f["id"]) for f in target[0]["frames"]}
    assert len(ours) == len(set(ours)) >= 40
    assert set(ours) <= theirs
    assert len(control[0]["epochs"]) == len(target[0]["epochs"])


def test_centre_is_a_few_arcminutes_from_wise0855(control, target):
    a, b = control[0]["center"], target[0]["center"]
    east = (a["ra"] - b["ra"]) * math.cos(math.radians(b["dec"])) * 3600
    north = (a["dec"] - b["dec"]) * 3600
    sep = math.hypot(east, north)
    # beyond the target's own 3' field (so the two cubes share no sky at the centre), close enough
    # to share the exposures
    assert 150 <= sep <= 240


def test_centre_is_blank_where_the_target_cube_has_a_source(control, target):
    blank = brightest_near_centre(control[1])
    source = brightest_near_centre(target[1])
    print(f"brightest pixel within 30\" of the centre: control {blank:.1f} sigma, WISE 0855 {source:.1f} sigma")
    assert blank < 5.0
    assert source > 10.0  # the same statistic does see WISE 0855, so a low value above means something


def test_measurement_reports_no_motion_on_blank_sky():
    def refuse(token):
        raise ValueError(f"{token} is not valid JSON")
    m = json.loads((CONTROL / "measure.json").read_text(encoding="utf-8"), parse_constant=refuse)
    assert m["object"] == "wise0855_control"
    assert m["motion"] is None or m["motion"]["status"] == "unverified"
    assert m["n_used"] < 0.5 * m["n_frames"]
