"""fov (3/6/10 arcmin) and /api/catalog (task C-08). Role A's fov builder (A-10) and catalogue query
(A-11) are not in main yet, so fakes stand in; the real ones are imported lazily when they arrive."""
import json
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import jobs
from backend.app import create_app
from backend.limits import Limiter
from backend.tests.test_cube_api import BARNARD, poll
from backend.tests.test_measure_api import RecordingClient, fake_measurer, poll_measure


def fov_builder(files, ra, dec, band, out_dir, fov_arcmin=3):
    """Stands in for data.cube.build_cube_from_files after A-10: grid fov*20+1."""
    n, side = len(files), fov_arcmin * 20 + 1
    (out_dir / "cube.f32").write_bytes(np.zeros((n, side, side), np.float32).tobytes())
    meta = dict(center=dict(ra=ra, dec=dec), pixscale_arcsec=3.0, shape=[n, side, side], fov_arcmin=fov_arcmin,
                frames=[dict(id=f.name, band=band, mjd=60900.0 + i) for i, f in enumerate(files)], data_url="cube.f32")
    (out_dir / "cube.json").write_text(json.dumps(meta))
    return meta


def old_builder(files, ra, dec, band, out_dir):
    """data.cube.build_cube_from_files as it is in main today: no fov."""
    return fov_builder(files, ra, dec, band, out_dir)


@pytest.fixture
def make(tmp_path):
    def make(builder=fov_builder, catalog_fetch=None, limiter=None, **client_kw):
        client = RecordingClient(tmp_path / "cache", **client_kw)
        app = create_app(client=client, cubes_dir=tmp_path / "cubes", builder=builder, measurer=fake_measurer,
                         max_frames=120, limiter=limiter or Limiter(10, 100), catalog_fetch=catalog_fetch)
        return TestClient(app), client
    return make


# ---------- fov ----------

def test_default_is_the_old_call_unchanged(make):
    calls = []

    def spy(*args, **kw):
        calls.append((len(args), kw))
        return old_builder(*args, **kw)
    http, client = make(builder=spy)
    cube = poll(http, BARNARD).json()
    assert calls == [(5, {})]                       # same positional call as before fov existed
    assert client.calls[0][2] == 0.05               # same cutout size
    assert cube["data_url"] == "/api/cubes/D1_269.4464_+4.7666/cube.f32"  # same cache key
    assert cube["shape"] == [5, 61, 61] and cube["fov_arcmin"] == 3
    assert poll(http, dict(BARNARD, fov="3")).json()["data_url"] == cube["data_url"]  # explicit 3 = default


def test_fov6_has_its_own_key_bigger_cutouts_and_121px(make):
    http, client = make()
    small = poll(http, BARNARD).json()
    r = poll(http, dict(BARNARD, fov=6))
    assert r.status_code == 200
    big = r.json()
    assert big["shape"] == [5, 121, 121] and big["fov_arcmin"] == 6
    assert big["data_url"] == "/api/cubes/D1_269.4464_+4.7666_f6/cube.f32" != small["data_url"]
    assert client.calls[1][2] == jobs.FOV_CUTOUT_FALLBACK[6] == 0.11
    px = http.get(big["data_url"])
    assert px.status_code == 200 and len(px.content) == 5 * 121 * 121 * 4


def test_fov10_is_capped_at_60_frames(make):
    http, client = make(n_images=500)
    cube = poll(http, dict(BARNARD, fov=10)).json()
    assert cube["shape"] == [60, 201, 201] and len(client.fetched) == 60
    assert client.calls[0][2] == 0.18


def test_fov_without_a10_builder_is_unavailable_but_3_works(make):
    http, client = make(builder=old_builder)
    r = poll(http, dict(BARNARD, fov=6))
    assert r.status_code == 503 and "A-10" in r.json()["message"] and client.tap_calls == 0
    assert poll(http, BARNARD).status_code == 200


def test_cutout_size_comes_from_data_cube_when_it_exists(monkeypatch):
    from data import cube
    monkeypatch.setattr(cube, "cutout_size_deg", lambda fov: {6: 0.12}[fov], raising=False)
    assert jobs.cutout_size_deg(6) == 0.12


@pytest.mark.parametrize("fov", ["4", "abc", "3.0", "0", "-6", "60"])
@pytest.mark.parametrize("path", ["/api/cube", "/api/measure"])
def test_bad_fov_is_422(make, path, fov):
    http, _ = make()
    assert http.get(path, params=dict(BARNARD, fov=fov)).status_code == 422


def test_measure_with_fov_uses_its_own_key_and_cutouts(make):
    http, client = make()
    assert poll_measure(http, BARNARD).status_code == 200
    assert poll_measure(http, dict(BARNARD, fov=6)).status_code == 200
    assert [c[2] for c in client.calls] == [0.05, 0.11]


def test_job_answer_reports_fov(make):
    import threading
    gate = threading.Event()
    http, _ = make(gate=gate)
    body = http.get("/api/cube", params=dict(BARNARD, fov=6)).json()
    assert body["fov_arcmin"] == 6
    gate.set()


# ---------- /api/catalog ----------

GAIA_BARNARD = dict(cat="gaia_dr3", id="4472832130942575872", ra=269.44850, dec=4.73942, epoch=2016.0,
                    pm_ra=-0.80, pm_dec=10.36, mag=8.2, mag_band="G")


def fake_sources_near(calls):
    def fetch(ra, dec, radius):
        calls.append((ra, dec, radius))
        return dict(center=dict(ra=ra, dec=dec), radius_arcsec=radius, sources=[GAIA_BARNARD],
                    source=dict(archive="NASA/IPAC IRSA (gaia_dr3_source, catwise_2020)", queried_utc="2026-11-14T07:00:00Z"))
    return fetch


def test_catalog_answer_cached_for_a_day(make):
    calls = []
    http, _ = make(catalog_fetch=fake_sources_near(calls))
    r = http.get("/api/catalog", params=dict(ra=269.4464, dec=4.7666, radius=150))
    assert r.status_code == 200
    body = r.json()
    assert body["sources"][0]["pm_dec"] == 10.36 and body["radius_arcsec"] == 150
    assert body["source"]["stale"] is False and body["source"]["saved_utc"]
    assert body["source"]["archive"].startswith("NASA/IPAC IRSA")
    assert http.get("/api/catalog", params=dict(ra=269.44641, dec=4.76661, radius=150)).json() == body
    assert len(calls) == 1
    assert http.get("/api/catalog", params=dict(ra=269.4464, dec=4.7666)).status_code == 200  # default radius 150
    assert len(calls) == 1


def test_catalog_irsa_down_gives_saved_answer_marked_stale(tmp_path):
    from backend.catalog import CatalogCache
    calls, clock = [], [1000.0]
    good = CatalogCache(tmp_path, fetch=fake_sources_near(calls), clock=lambda: clock[0])
    first = good.get(269.4464, 4.7666, 150)

    def down(ra, dec, radius):
        raise TimeoutError("IRSA TAP read timed out")
    clock[0] += 2 * 24 * 3600
    later = CatalogCache(tmp_path, fetch=down, clock=lambda: clock[0])
    again = later.get(269.4464, 4.7666, 150)
    assert again["sources"] == first["sources"]
    assert again["source"]["stale"] is True and "timed out" in again["source"]["error"]
    assert again["source"]["saved_utc"] == first["source"]["saved_utc"]


def test_catalog_errors(make):
    def down(ra, dec, radius):
        raise ConnectionError("IRSA 503")

    def nan(ra, dec, radius):
        return dict(sources=[dict(GAIA_BARNARD, pm_ra=math.nan)])
    http, _ = make(catalog_fetch=down)
    r = http.get("/api/catalog", params=dict(ra=10.0, dec=20.0))
    assert r.status_code == 502 and r.json()["status"] == "error"
    http, _ = make(catalog_fetch=nan)
    assert http.get("/api/catalog", params=dict(ra=10.0, dec=20.0)).status_code == 502


def test_catalog_not_available_yet(make):
    http, _ = make(catalog_fetch=None)
    r = http.get("/api/catalog", params=dict(ra=10.0, dec=20.0))
    assert r.status_code == 503 and "A-11" in r.json()["message"]
    assert http.get("/health").json()["catalog_pipeline"] is False


@pytest.mark.parametrize("params", [dict(ra=10, dec=20, radius=0), dict(ra=10, dec=20, radius=601),
                                    dict(ra=400, dec=20), dict(ra=10, dec=-91)])
def test_catalog_bad_parameters(make, params):
    http, _ = make(catalog_fetch=fake_sources_near([]))
    assert http.get("/api/catalog", params=params).status_code == 422


def test_catalog_counts_against_the_limit_only_when_it_queries(make):
    calls = []
    http, _ = make(catalog_fetch=fake_sources_near(calls), limiter=Limiter(10, 1))
    assert http.get("/api/catalog", params=dict(ra=10.0, dec=20.0)).status_code == 200
    assert http.get("/api/catalog", params=dict(ra=10.0, dec=20.0)).status_code == 200  # cached: free
    assert http.get("/api/catalog", params=dict(ra=11.0, dec=20.0)).status_code == 429
