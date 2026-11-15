"""/api/cube and /cubes tests. No network and no real cube pipeline: a fake IRSA client and a
fake builder stand in for them. The fake builder exists only in this test file -- the app never
produces cube data without data/cube.py."""
import json
import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import irsa
from backend.app import create_app

URI = "ibe/data/spherex/dr1/level2/2025W35_1A/l2b-v27-2026-230/1/level2_2025W35_1A_{:04d}_4D1_spx_l2b-v27-2026-230.fits"
BARNARD = dict(ra=269.4464, dec=4.7666, band="D1")


class FakeClient:
    max_concurrent, retries = 8, 3

    def __init__(self, cache_dir, n_images=5, fail=(), tap_error=False, gate=None):
        self.cache_dir = cache_dir
        self.rows = [dict(uri=URI.format(i), band="SPHEREx-D1", mjd=60900.0 + i) for i in range(n_images)]
        self.fail, self.tap_error, self.gate = set(fail), tap_error, gate
        self.tap_calls, self.fetched = 0, []

    def query_images(self, ra, dec, band=None):
        self.tap_calls += 1
        if self.tap_error:
            raise irsa.IrsaError("TAP query: gave up after 4 attempts (503)", 503)
        return list(self.rows)

    def fetch_cutouts(self, uris, ra, dec, size_deg=0.05, progress=None, retries=None):
        out = []
        for i, u in enumerate(uris, 1):
            if self.gate:
                self.gate.wait(5)
            self.fetched.append(u)
            if u in self.fail:
                out.append(irsa.IrsaError("HTTP 404", 404))
            else:
                p = self.cache_dir / "cutouts" / u.rsplit("/", 1)[1]
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b"x")
                out.append(p)
            if progress:
                progress(i, len(uris))
        return out


def fake_builder(files, ra, dec, band, out_dir):
    n = len(files)
    data = np.zeros((n, 61, 61), np.float32)
    (out_dir / "cube.f32").write_bytes(data.tobytes())
    meta = dict(center=dict(ra=ra, dec=dec), pixscale_arcsec=3.0, shape=[n, 61, 61],
                frames=[dict(id=f.name, band=band, mjd=60900.0 + i, lam_um=1.0, noise=1.0, nan_frac=0.0)
                        for i, f in enumerate(files)], data_url="cube.f32")
    (out_dir / "cube.json").write_text(json.dumps(meta))
    return meta


def poll(http, params, timeout=5):
    t = time.time()
    while True:
        r = http.get("/api/cube", params=params)
        if r.status_code != 202 or time.time() - t > timeout:
            return r
        time.sleep(0.02)


@pytest.fixture
def make(tmp_path):
    def make(builder=fake_builder, cubes_dir=None, **client_kw):
        client = FakeClient(tmp_path / "cache", **client_kw)
        app = create_app(client=client, cubes_dir=cubes_dir or tmp_path / "cubes", builder=builder, max_frames=120)
        return TestClient(app), client
    return make


# ---------- static cubes ----------

def test_static_cube_served_as_files(make, tmp_path):
    d = tmp_path / "cubes" / "barnard" / "D1"
    d.mkdir(parents=True)
    (d / "cube.json").write_text('{"shape":[2,61,61],"data_url":"cube.f32"}')
    (d / "cube.f32").write_bytes(np.arange(8, dtype=np.float32).tobytes())
    http, _ = make()
    r = http.get("/cubes/barnard/D1/cube.json")
    assert r.status_code == 200 and r.json()["data_url"] == "cube.f32"
    r = http.get("/cubes/barnard/D1/cube.f32")
    assert r.status_code == 200 and np.frombuffer(r.content, np.float32).tolist() == list(range(8))
    assert http.get("/cubes/nope/D1/cube.json").status_code == 404


def test_missing_static_dir_is_404_not_crash(make, tmp_path):
    http, _ = make(cubes_dir=tmp_path / "does-not-exist")
    assert http.get("/cubes/barnard/D1/cube.json").status_code == 404
    assert http.get("/health").json()["static_cubes"] is False


def test_cors_allows_local_frontend(make):
    http, _ = make()
    r = http.get("/health", headers={"Origin": "http://localhost:3000"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"


# ---------- /api/cube ----------

def test_cube_job_reports_progress_then_returns_cube(make):
    gate = threading.Event()
    http, client = make(gate=gate)
    r = http.get("/api/cube", params=BARNARD)
    assert r.status_code == 202
    body = r.json()
    assert body["status"] in ("queued", "searching", "downloading") and 0 <= body["progress"] < 1
    gate.set()
    r = poll(http, BARNARD)
    assert r.status_code == 200
    cube = r.json()
    assert cube["status"] == "done" and cube["shape"] == [5, 61, 61] and len(cube["frames"]) == 5
    # data_url is absolute so it resolves from /api/cube?...
    assert cube["data_url"].startswith("/api/cubes/D1_269.4464_+4.7666/")
    px = http.get(cube["data_url"])
    assert px.status_code == 200 and len(px.content) == 5 * 61 * 61 * 4


def test_finished_cube_is_not_rebuilt(make):
    http, client = make()
    assert poll(http, BARNARD).status_code == 200
    calls = client.tap_calls
    r = http.get("/api/cube", params=dict(BARNARD, ra=269.44641))  # same cube within 0.36"
    assert r.status_code == 200 and client.tap_calls == calls


def test_concurrent_requests_share_one_job(make):
    gate = threading.Event()
    http, client = make(gate=gate)
    for _ in range(5):
        assert http.get("/api/cube", params=BARNARD).status_code == 202
    gate.set()
    assert poll(http, BARNARD).status_code == 200
    assert client.tap_calls == 1 and len(client.fetched) == 5


def test_deep_field_is_subsampled(make):
    http, client = make(n_images=500)
    cube = poll(http, BARNARD).json()
    assert cube["shape"][0] == 120 and len(client.fetched) == 120
    assert client.fetched[0] == URI.format(0) and client.fetched[-1] == URI.format(499)


def test_some_cutouts_failing_still_builds(make):
    http, _ = make(fail={URI.format(1), URI.format(3)})
    cube = poll(http, BARNARD).json()
    assert cube["shape"][0] == 3


def test_all_cutouts_failing_is_error(make):
    http, _ = make(fail={URI.format(i) for i in range(5)})
    r = poll(http, BARNARD)
    assert r.status_code == 502 and r.json()["status"] == "error" and r.json()["n_failed"] == 5


def test_irsa_search_down_is_error(make):
    http, _ = make(tap_error=True)
    r = poll(http, BARNARD)
    body = r.json()
    # C-13: a sentence for a person, no status codes or URLs (those go to the log)
    assert r.status_code == 502 and body["reason"] == "search_down"
    assert "five example objects" in body["message"] and "503" not in body["message"]


def test_no_images_is_404(make):
    http, _ = make(n_images=0)
    r = poll(http, BARNARD)
    assert r.status_code == 404 and r.json()["status"] == "empty"


def test_without_pipeline_says_unavailable_and_invents_nothing(make, tmp_path):
    http, client = make(builder=None)
    r = poll(http, BARNARD)
    assert r.status_code == 503 and r.json()["status"] == "unavailable"
    assert client.tap_calls == 0 and not list((tmp_path / "cache").rglob("cube.*"))
    assert http.get("/health").json()["cube_pipeline"] is False


def test_builder_crash_is_reported(make):
    def broken(*a):
        raise ValueError("reproject failed")
    http, _ = make(builder=broken)
    r = poll(http, BARNARD)
    assert r.status_code == 502 and "reproject failed" in r.json()["message"]


@pytest.mark.parametrize("params", [dict(BARNARD, band="D9"), dict(BARNARD, ra=400), dict(BARNARD, dec=-91),
                                    {"ra": "abc", "dec": 1}])
def test_bad_parameters_are_422(make, params):
    http, _ = make()
    assert http.get("/api/cube", params=params).status_code == 422


@pytest.mark.parametrize("path", ["/api/cubes/../cube.f32", "/api/cubes/D1_1.0000_+2.0000/secret.txt",
                                  "/api/cubes/D1_1.0000_+2.0000/cube.f32"])
def test_cube_file_route_only_serves_built_cubes(make, path):
    http, _ = make()
    assert http.get(path).status_code == 404


# ---------- deploy (C-03) ----------

def test_cors_regex_allows_vercel_previews(tmp_path, monkeypatch):
    monkeypatch.setenv("OSU_CORS_ORIGIN_REGEX", r"^https://osu-spherex[a-z0-9-]*\.vercel\.app$")
    http = TestClient(create_app(client=FakeClient(tmp_path), cubes_dir=tmp_path, builder=fake_builder))
    ok = http.get("/health", headers={"Origin": "https://osu-spherex-git-main-abc.vercel.app"})
    assert ok.headers.get("access-control-allow-origin") == "https://osu-spherex-git-main-abc.vercel.app"
    bad = http.get("/health", headers={"Origin": "https://evil.vercel.app"})
    assert "access-control-allow-origin" not in bad.headers


def test_health_is_cheap_on_a_cold_start():
    """Render's health check and the pre-demo wake-up call hit /health first; it must not pull in
    astropy/reproject (data.cube) -- that import alone takes ~19 s on a cold free instance."""
    import subprocess
    import sys
    code = ("import sys; from fastapi.testclient import TestClient; from backend.app import app; "
            "r = TestClient(app).get('/health'); assert r.status_code == 200, r.text; "
            "assert r.json()['cube_pipeline'] is True; "
            "heavy = [m for m in ('data.cube', 'astropy', 'reproject') if m in sys.modules]; "
            "assert not heavy, heavy")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr[-2000:]
