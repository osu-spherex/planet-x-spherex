"""Saved image lists for when the archive's search is down (task A-17). Offline: no network, no image cache.

Outside answers used:
  * The challenge page's coordinates of WISE 0855: RA 08h55m10.831s, Dec -07d14m42.53s = 133.79513, -7.24515
    (https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).
  * Barnard's Star in SIMBAD, ICRS J2000: 17h57m48.498s +04d41m36.11s = 269.45208, 4.69336.
  * The number of images per object in the DR1 download of 2026-11-14 (tasks/A.md, A-17).
"""
import csv
import json
from collections import Counter
from pathlib import Path

import pytest

from data import listing

WISE0855_CHALLENGE = (133.79513, -7.24515)
BARNARD_SIMBAD = (269.45208, 4.69336)
COUNTS = dict(barnard=358, epsindb=458, rdra=778, rwaur=335, wise0855=258)


def file_rows():
    with open(listing.LISTING, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_file_has_the_rows_of_the_download_and_nothing_else():
    rows = file_rows()
    assert list(rows[0]) == ["object", "band", "mjd", "uri"]
    assert dict(Counter(r["object"] for r in rows)) == COUNTS
    assert len({r["uri"] for r in rows}) == len(rows) == 2187  # no image twice
    for r in rows:
        assert r["band"] in listing.BANDS
        assert r["uri"].startswith("ibe/data/spherex/") and r["uri"].endswith(".fits")
        assert 60700 < float(r["mjd"]) < 61400  # SPHEREx survey, 2025-2026
        assert f"D{r['band'][-1]}_spx_" in r["uri"]  # the detector in the file name is the detector of the row


def test_file_is_the_local_manifest_where_there_is_one():
    from data import cube  # only here: needs astropy
    manifest = cube.cache_dir().parent / "cache_dr1" / "manifest.csv"
    if not manifest.exists():
        pytest.skip(f"no DR1 cache at {manifest.parent}")
    with open(manifest, newline="", encoding="utf-8") as f:
        there = {(r["object"], r["band"], r["mjd"], r["uri"]) for r in csv.DictReader(f)}
    here = {(r["object"], r["band"], r["mjd"], r["uri"]) for r in file_rows()}
    # the cache may have grown since (python -m data.refresh); every saved row must still be a real one
    assert here <= there


def test_challenge_coordinates_of_wise0855_get_the_wise0855_list():
    rows, info = listing.saved_images(*WISE0855_CHALLENGE, "D6")
    assert info["object"] == "wise0855" and info["listed"] == "2026-11-14"
    assert 1.5 < info["sep_arcmin"] < 3.0  # it has moved 2 arcmin since 2010
    assert len(rows) == 45 >= 40
    for r in rows:
        assert set(r) == {"uri", "band", "mjd"}  # the row shape of backend/irsa.py query_images
        assert r["band"] == "SPHEREx-D6" and isinstance(r["mjd"], float)
        assert r["uri"].startswith("ibe/data/spherex/")
    assert [r["mjd"] for r in rows] == sorted(r["mjd"] for r in rows)
    json.dumps(rows), json.dumps(info)


def test_both_spellings_of_a_detector_and_no_detector_at_all():
    short, _ = listing.saved_images(*WISE0855_CHALLENGE, "D6")
    full, _ = listing.saved_images(*WISE0855_CHALLENGE, "SPHEREx-D6")
    lower, _ = listing.saved_images(*WISE0855_CHALLENGE, "d6")
    assert short == full == lower
    every, _ = listing.saved_images(*WISE0855_CHALLENGE)
    assert len(every) == COUNTS["wise0855"] and {r["band"] for r in every} == set(listing.BANDS)
    assert [r["mjd"] for r in every] == sorted(r["mjd"] for r in every)
    with pytest.raises(ValueError):
        listing.saved_images(*WISE0855_CHALLENGE, "D7")


def test_simbad_position_of_barnards_star_gets_the_barnard_list():
    rows, info = listing.saved_images(*BARNARD_SIMBAD)
    assert info["object"] == "barnard" and len(rows) == COUNTS["barnard"]
    assert 4.0 < info["sep_arcmin"] < 5.0  # 26 years at 10.4 arcsec/yr
    d1, _ = listing.saved_images(*BARNARD_SIMBAD, "D1")
    assert len(d1) == 60


def test_far_from_every_demo_object_there_is_nothing_to_offer():
    assert listing.saved_images(WISE0855_CHALLENGE[0], WISE0855_CHALLENGE[1] + 1.0, "D6") is None  # one degree north
    assert listing.saved_images(10.0, 80.0) is None
    assert listing.saved_images(*WISE0855_CHALLENGE, "D6", max_sep_arcmin=1.0) is None  # the limit is the caller's
    # at the pole and across RA = 0 the distance is still an angle on the sky, not a difference of numbers
    assert listing.separation_arcmin(0.0, 90.0, 180.0, 90.0) == pytest.approx(0.0, abs=1e-6)
    assert listing.separation_arcmin(359.99, 0.0, 0.01, 0.0) == pytest.approx(1.2, abs=1e-6)


def test_the_caller_gets_copies():
    rows, _ = listing.saved_images(*WISE0855_CHALLENGE, "D6")
    rows[0]["uri"] = "changed"
    again, _ = listing.saved_images(*WISE0855_CHALLENGE, "D6")
    assert again[0]["uri"].startswith("ibe/data/spherex/")


def test_every_object_with_a_list_has_a_cube_centre():
    centres = listing._centres(str(listing.CUBES))
    for obj in COUNTS:
        ra, dec = centres[obj]
        rows, info = listing.saved_images(ra, dec)
        assert info == dict(object=obj, sep_arcmin=0.0, listed="2026-11-14") and len(rows) == COUNTS[obj]


def test_a_small_listing_of_ones_own(tmp_path):
    # what role C's tests need: a temporary file in place of the real one
    cube_dir = tmp_path / "cubes" / "star" / "D1"
    cube_dir.mkdir(parents=True)
    (cube_dir / "cube.json").write_text(json.dumps(dict(center=dict(ra=10.0, dec=20.0))), encoding="utf-8")
    path = tmp_path / "small.csv"
    path.write_text("object,band,mjd,uri\nstar,SPHEREx-D1,61000.5,ibe/data/spherex/b.fits\nstar,SPHEREx-D1,60900.25,ibe/data/spherex/a.fits\n"
                    "ghost,SPHEREx-D1,60900.25,ibe/data/spherex/c.fits\n", encoding="utf-8")
    rows, info = listing.saved_images(10.01, 20.0, "D1", listing=path, cubes=tmp_path / "cubes")
    assert [r["uri"] for r in rows] == ["ibe/data/spherex/a.fits", "ibe/data/spherex/b.fits"]
    assert info["object"] == "star"  # "ghost" has rows but no cube, so no position: it is never offered
    assert listing.saved_images(10.0, 20.0, "D2", listing=path, cubes=tmp_path / "cubes")[0] == []
