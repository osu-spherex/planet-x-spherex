"""Tests for task A-12: data/refresh.py, the one-command update of the static demo data.

No network and no cache: the archive is a fake client, the cache a temporary folder. The file
names are the real IRSA naming scheme, taken from the cache manifests of 2026-11-10 (quick
release) and 2026-11-14 (DR1):

    qr2/level2/2025W35_1A/l2b-v20-2025-269/1/level2_2025W35_1A_0432_4D1_spx_l2b-v20-2025-269.fits
    dr1/level2/2025W35_1A/l2b-v27-2026-230/1/level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits

Same exposure (2025W35_1A_0432_4D1), two processing versions. That is the case this module
exists for: on 2026-11-14 a re-download under the new names would have put every observation into
the cache twice (CLAUDE.md, "IRSA одоо DR1 өгдөг").
"""
import csv
from pathlib import Path

import pytest

from data import fetch_bands, refresh

BASE = "ibe/data/spherex"


def uri(exposure, version="l2b-v20-2025-269", release="qr2", week="2025W35_1A"):
    det = exposure[-1]
    return f"{BASE}/{release}/level2/{week}/{version}/{det}/level2_{exposure}_spx_{version}.fits"


def archive_row(exposure, mjd, **kw):
    return dict(uri=uri(exposure, **kw), band=f"SPHEREx-D{exposure[-1]}", mjd=mjd)


def manifest_row(obj, exposure, mjd, **kw):
    u = uri(exposure, **kw)
    return dict(object=obj, band=f"SPHEREx-D{exposure[-1]}", mjd=f"{mjd:.6f}", uri=u, center_ra="269.4462864",
                center_dec="4.7680655", size_deg="0.05", file=f"{obj}/D{exposure[-1]}/{Path(u).name}", bytes="0",
                downloaded_utc="2026-11-10T12:00:00Z")


EXPOSURES = [("2025W35_1A_0432_4D1", 60914.21253), ("2025W35_1A_0658_1D1", 60915.431134),
             ("2025W41_2B_0101_2D1", 60958.5), ("2026W08_1A_0007_3D1", 61088.25)]


def test_names_are_split_into_exposure_and_version():
    name = "level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits"
    assert refresh.exposure(name) == "level2_2025W35_1A_0432_4D1"
    assert refresh.exposure(f"{BASE}/dr1/level2/2025W35_1A/l2b-v27-2026-230/1/{name}") == "level2_2025W35_1A_0432_4D1"
    assert refresh.version(name) == "l2b-v27-2026-230"
    assert refresh.release(uri("2025W35_1A_0432_4D1", release="dr1")) == "dr1"
    # 12 files of the DR1 cache carry this other kind of version name
    retry = "level2_2025W50_2A_0374_1D2_spx_l2b_retry-v27-2026-210.fits"
    assert refresh.exposure(retry) == "level2_2025W50_2A_0374_1D2"
    assert refresh.short_version(retry) == "l2b_retry-v27" and refresh.short_version(name) == "l2b-v27"
    # "newer" goes by pipeline number and processing date, not by the spelling of the name
    assert refresh.version_key("x_spx_l2b-v27-2026-230.fits") > refresh.version_key("x_spx_l2b_retry-v27-2026-210.fits")
    assert refresh.version_key("x_spx_l2b-v27-2026-001.fits") > refresh.version_key("x_spx_l2b-v25-2026-300.fits")


def test_nothing_to_do_when_the_archive_serves_what_the_cache_holds():
    have = [manifest_row("barnard", e, m) for e, m in EXPOSURES]
    plan = refresh.plan_band(have, [archive_row(e, m) for e, m in EXPOSURES])
    assert plan["download"] == [] and plan["drop"] == []
    assert [r["uri"] for r in plan["keep"]] == [r["uri"] for r in have]


def test_a_new_observation_is_downloaded_and_the_rest_kept():
    have = [manifest_row("barnard", e, m) for e, m in EXPOSURES[:3]]
    plan = refresh.plan_band(have, [archive_row(e, m) for e, m in EXPOSURES])
    assert [(Path(r["uri"]).name, why) for r, why in plan["download"]] == \
        [("level2_2026W08_1A_0007_3D1_spx_l2b-v20-2025-269.fits", "new")]
    assert len(plan["keep"]) == 3 and plan["drop"] == []


def test_a_reprocessed_exposure_replaces_the_old_file_instead_of_joining_it():
    """The DR1 case: same exposures, new version. Every frame must be in the cube once."""
    have = [manifest_row("barnard", e, m) for e, m in EXPOSURES]
    new = dict(version="l2b-v27-2026-230", release="dr1")
    archive = [archive_row(e, m, **new) for e, m in EXPOSURES[:2]] + [archive_row(e, m) for e, m in EXPOSURES[2:]]
    plan = refresh.plan_band(have, archive)
    assert [why for _, why in plan["download"]] == ["reprocessed l2b-v20-2025-269 -> l2b-v27-2026-230"] * 2
    assert [(refresh.exposure(r["uri"]), why) for r, why in plan["drop"]] == \
        [("level2_2025W35_1A_0432_4D1", "replaced"), ("level2_2025W35_1A_0658_1D1", "replaced")]
    after = [r["uri"] for r in plan["keep"]] + [r["uri"] for r, _ in plan["download"]]
    assert sorted(refresh.exposure(u) for u in after) == sorted(f"level2_{e}" for e, _ in EXPOSURES)


def test_an_exposure_served_in_two_versions_is_taken_once_in_the_newer_one():
    old, new = archive_row(*EXPOSURES[0]), archive_row(*EXPOSURES[0], version="l2b-v27-2026-230", release="dr1")
    plan = refresh.plan_band([], [old, new, old])
    assert [Path(r["uri"]).name for r, _ in plan["download"]] == ["level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits"]
    assert plan["n_archive"] == 1


def test_an_image_the_archive_no_longer_lists_leaves_the_cache_list():
    have = [manifest_row("barnard", e, m) for e, m in EXPOSURES]
    plan = refresh.plan_band(have, [archive_row(e, m) for e, m in EXPOSURES[1:]])
    assert [(refresh.exposure(r["uri"]), why) for r, why in plan["drop"]] == \
        [("level2_2025W35_1A_0432_4D1", "no longer in the archive")]


def test_deep_fields_keep_the_even_subsample_of_fetch_bands():
    rows = [archive_row(f"2025W35_1A_{i:04d}_1D1", 60900.0 + i) for i in range(10)]
    plan = refresh.plan_band([], rows, limit=4)
    assert plan["n_archive"] == 10
    assert [r["uri"] for r, _ in plan["download"]] == [r["uri"] for r in fetch_bands.subsample(rows, 4)]
    # an image that the subsample passes over is dropped with that reason, not as "gone"
    have = [manifest_row("rdra", "2025W35_1A_0001_1D1", 60901.0)]
    plan = refresh.plan_band(have, rows, limit=4)
    assert [why for _, why in plan["drop"]] == ["left out by the even subsample of 4"]


def test_an_empty_answer_never_empties_a_detector():
    have = [manifest_row("barnard", e, m) for e, m in EXPOSURES]
    with pytest.raises(refresh.RefreshError, match="no images"):
        refresh.plan_band(have, [])
    assert refresh.plan_band([], [])["download"] == []  # a detector that never saw the field is fine


# ---------- with a cache on disk and a fake archive ----------

class FakeClient:
    """Stands in for backend.irsa.IrsaClient: a fixed archive listing, downloads that write a marker file."""

    def __init__(self, rows, tmp, fail=(), stale=False):
        self.rows, self.tmp, self.fail, self.stale = rows, Path(tmp), set(fail), stale
        self.fetched = []

    def query_images_meta(self, ra, dec, band=None):
        return self.rows, dict(saved_utc="2026-11-15T00:00:00Z", stale=self.stale)

    def fetch_cutouts(self, uris, ra, dec, size_deg=0.05, **kw):
        from backend.irsa import IrsaError
        out = []
        for u in uris:
            self.fetched.append(u)
            if Path(u).name in self.fail:
                out.append(IrsaError("503 Service Unavailable", 503))
                continue
            p = self.tmp / "dl" / Path(u).name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"new " + Path(u).name.encode())
            out.append(p)
        return out


def make_cache(tmp_path, rows):
    cache = tmp_path / "cache"
    for r in rows:
        p = cache / r["file"]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"old " + p.name.encode())
    cache.mkdir(exist_ok=True)
    fetch_bands.write_manifest(cache, rows)
    return cache


def read_manifest(cache):
    with open(cache / "manifest.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


DR1 = dict(version="l2b-v27-2026-230", release="dr1")


def test_dry_run_lists_the_work_and_touches_nothing(tmp_path, capsys):
    cache = make_cache(tmp_path, [manifest_row("barnard", e, m) for e, m in EXPOSURES[:3]])
    before = (cache / "manifest.csv").read_bytes()
    client = FakeClient([archive_row(*EXPOSURES[0], **DR1)] + [archive_row(e, m) for e, m in EXPOSURES[1:]], tmp_path)
    code = refresh.main(["barnard", "--dry-run", "--cache-dir", str(cache), "--cubes", str(tmp_path / "cubes")], client=client)
    text = capsys.readouterr().out
    assert code == 0
    assert "level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits" in text and "reprocessed" in text
    assert "level2_2026W08_1A_0007_3D1_spx_l2b-v20-2025-269.fits" in text and "new" in text
    assert "2 to download" in text
    for name in ("cube.json", "cube.f32", "flags.u8", "measure.json", "spectrum.json", "catalog.json", "coverage.json"):
        assert name in text  # what a real run would write
    assert client.fetched == []
    assert (cache / "manifest.csv").read_bytes() == before
    assert not (tmp_path / "cubes").exists()


def test_fetch_replaces_reprocessed_files_and_keeps_the_old_one_if_its_download_fails(tmp_path, capsys):
    cache = make_cache(tmp_path, [manifest_row("barnard", e, m) for e, m in EXPOSURES[:3]])
    archive = [archive_row(e, m, **DR1) for e, m in EXPOSURES[:2]] + [archive_row(e, m) for e, m in EXPOSURES[2:]]
    failing = "level2_2025W35_1A_0658_1D1_spx_l2b-v27-2026-230.fits"
    client = FakeClient(archive, tmp_path, fail=[failing])
    failed = refresh.update_cache("barnard", cache, client)
    assert failed == 1
    rows = read_manifest(cache)
    assert sorted(Path(r["file"]).name for r in rows) == sorted([
        "level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits",   # reprocessed, downloaded
        "level2_2025W35_1A_0658_1D1_spx_l2b-v20-2025-269.fits",   # its replacement failed: the old one stays
        "level2_2025W41_2B_0101_2D1_spx_l2b-v20-2025-269.fits",   # unchanged
        "level2_2026W08_1A_0007_3D1_spx_l2b-v20-2025-269.fits",   # new
    ])
    assert len({refresh.exposure(r["file"]) for r in rows}) == 4  # no exposure twice
    for r in rows:
        assert (cache / r["file"]).exists()
        assert r["center_ra"] == "269.4462864" and r["size_deg"] == "0.05"
    new = next(r for r in rows if r["file"].endswith("0432_4D1_spx_l2b-v27-2026-230.fits"))
    assert new["uri"] == archive[0]["uri"] and (cache / new["file"]).read_bytes().startswith(b"new ")

    # second run with the archive healthy: only the one that failed is asked for again
    client = FakeClient(archive, tmp_path)
    assert refresh.update_cache("barnard", cache, client) == 0
    assert [Path(u).name for u in client.fetched] == [failing]
    assert len(read_manifest(cache)) == 4
    # superseded files stay on disk until asked: --prune removes exactly the ones the manifest dropped
    old = cache / "barnard" / "D1" / "level2_2025W35_1A_0432_4D1_spx_l2b-v20-2025-269.fits"
    assert old.exists()
    assert sorted(p.name for p in refresh.superseded("barnard", cache)) == [
        "level2_2025W35_1A_0432_4D1_spx_l2b-v20-2025-269.fits", "level2_2025W35_1A_0658_1D1_spx_l2b-v20-2025-269.fits"]


def test_a_saved_archive_answer_is_not_passed_off_as_fresh(tmp_path):
    cache = make_cache(tmp_path, [manifest_row("barnard", e, m) for e, m in EXPOSURES])
    client = FakeClient([archive_row(e, m) for e, m in EXPOSURES], tmp_path, stale=True)
    with pytest.raises(refresh.RefreshError, match="--offline"):
        refresh.update_cache("barnard", cache, client)


def test_an_object_that_is_not_in_the_cache_is_named(tmp_path):
    cache = make_cache(tmp_path, [manifest_row("barnard", e, m) for e, m in EXPOSURES])
    with pytest.raises(refresh.RefreshError, match="teegarden"):
        refresh.update_cache("teegarden", cache, FakeClient([], tmp_path))


def test_the_report_says_what_changed():
    old = dict(n=43, epochs=4, last_mjd=61289.4, releases={"qr2": 43}, versions={"l2b-v20": 43}, pixels="a", measure="x")
    new = dict(n=45, epochs=4, last_mjd=61289.4, releases={"dr1": 45}, versions={"l2b-v27": 45}, pixels="b", measure="y")
    line = refresh.describe("wise0855", "D6", old, new)
    assert "43 -> 45 frames" in line and "qr2 43 -> dr1 45" in line and "l2b-v20 -> l2b-v27" in line
    assert "2026-09-06" in line  # MJD 60000 is 2023-02-25 (definition of MJD); 1289 days later is 2026-09-06
    assert "unchanged" in refresh.describe("wise0855", "D6", new, dict(new))
    assert "new cube" in refresh.describe("wise0855", "D6", None, new)
