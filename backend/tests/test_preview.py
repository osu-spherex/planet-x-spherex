"""Quick first look (task C-09): /api/cube?...&preview=1 answers a small cube built from 2 images per
visit while the full cube is still downloading. Without preview=1 nothing changes."""
import threading
import time

import pytest
from fastapi.testclient import TestClient

from backend import irsa, jobs
from backend.app import create_app
from backend.limits import Limiter
from backend.tests.test_cube_api import BARNARD, URI, FakeClient, fake_builder, poll

VISITS = [60914.0, 60949.0, 61110.0, 61276.0]  # Barnard-like: four visits months apart


class VisitClient(FakeClient):
    """15 images per visit; the first fetch_cutouts call (the preview) goes through at once,
    later ones wait for `full_gate` so the test can look at the in-between state."""

    def __init__(self, cache_dir, per_visit=15, visits=VISITS, **kw):
        super().__init__(cache_dir, n_images=0, **kw)
        self.rows = [dict(uri=URI.format(v * 100 + i), band="SPHEREx-D1", mjd=m + 0.1 * i)
                     for v, m in enumerate(visits) for i in range(per_visit)]
        self.full_gate = threading.Event()
        self.batches = []

    def fetch_cutouts(self, uris, ra, dec, size_deg=0.05, progress=None, retries=None):
        self.batches.append(len(uris))
        self.retries_seen = getattr(self, "retries_seen", []) + [retries]
        if len(self.batches) > 1:
            self.full_gate.wait(5)
        return super().fetch_cutouts(uris, ra, dec, size_deg, progress, retries)


@pytest.fixture
def make(tmp_path):
    def make(builder=fake_builder, **kw):
        client = VisitClient(tmp_path / "cache", **kw)
        app = create_app(client=client, cubes_dir=tmp_path / "cubes", builder=builder,
                         max_frames=120, limiter=Limiter(10, 100))
        return TestClient(app), client
    return make


def wait_for(http, params, status, timeout=5):
    t = time.time()
    while time.time() - t < timeout:
        r = http.get("/api/cube", params=params)
        if r.json().get("status") == status:
            return r
        time.sleep(0.02)
    raise AssertionError(f"never reached {status}: {r.status_code} {r.json()}")


# ---------- which images make the first look ----------

def test_two_images_from_every_visit():
    rows = [dict(uri=f"u{v}_{i}", band="SPHEREx-D1", mjd=m + 0.1 * i) for v, m in enumerate(VISITS) for i in range(15)]
    pick = jobs.preview_subset(rows)
    assert len(pick) == 8
    by_visit = [sum(1 for p in pick if p["uri"].startswith(f"u{v}_")) for v in range(4)]
    assert by_visit == [2, 2, 2, 2]
    assert pick[0] == rows[0] and pick[-1] == rows[-1]  # first and last image: the widest time span


def test_more_visits_than_room_keeps_first_and_last_visit():
    rows = [dict(uri=f"u{v}_{i}", band="b", mjd=60000 + 40 * v + 0.1 * i) for v in range(6) for i in range(5)]
    pick = jobs.preview_subset(rows)
    assert len(pick) == 8 and pick[0]["uri"].startswith("u0_") and pick[-1]["uri"].startswith("u5_")


def test_tiny_field_previews_what_there_is():
    rows = [dict(uri="a", band="b", mjd=60000.0), dict(uri="b", band="b", mjd=60100.0)]
    assert jobs.preview_subset(rows) == rows


# ---------- API ----------

def test_preview_then_full_cube(make):
    http, client = make()
    params = dict(BARNARD, preview=1)
    assert http.get("/api/cube", params=params).status_code in (200, 202)
    r = wait_for(http, params, "preview")
    assert r.status_code == 200
    first = r.json()
    assert first["complete"] is False and first["shape"] == [8, 61, 61] and first["n_images"] == 60
    assert 0.05 <= first["progress"] < 1 and "server_started_utc" in first
    assert first["data_url"] == "/api/cubes/D1_269.4464_+4.7666.preview/cube.f32"
    px = http.get(first["data_url"])
    assert px.status_code == 200 and len(px.content) == 8 * 61 * 61 * 4
    client.full_gate.set()
    done = wait_for(http, params, "done").json()
    assert done["complete"] is True and done["shape"] == [60, 61, 61]
    assert client.batches == [8, 60]  # the 8 preview cutouts are fetched again from the disk cache, not IRSA


def test_without_preview_param_nothing_changes(make):
    http, client = make()
    assert http.get("/api/cube", params=dict(BARNARD, preview=1)).status_code in (200, 202)
    wait_for(http, dict(BARNARD, preview=1), "preview")  # a preview exists now ...
    r = http.get("/api/cube", params=BARNARD)              # ... but a plain caller still gets the old answer
    assert r.status_code == 202 and r.json()["status"] == "downloading" and "complete" not in r.json()
    client.full_gate.set()
    done = poll(http, BARNARD).json()
    assert done["status"] == "done" and "complete" not in done and done["shape"] == [60, 61, 61]


def test_plain_job_builds_no_preview(make):
    http, client = make()
    client.full_gate.set()
    assert poll(http, BARNARD).status_code == 200
    assert client.batches == [60]  # one download pass, no first-look batch


def test_failed_preview_does_not_stop_the_full_cube(make):
    def picky(files, ra, dec, band, out_dir):
        if len(files) <= 8:
            raise ValueError("preview build broke")
        return fake_builder(files, ra, dec, band, out_dir)
    http, client = make(builder=picky)
    client.full_gate.set()
    done = wait_for(http, dict(BARNARD, preview=1), "done").json()
    assert done["complete"] is True and done["shape"] == [60, 61, 61]


@pytest.mark.parametrize("value", ["2", "yes", "true"])
def test_bad_preview_value_is_422(make, value):
    http, _ = make()
    assert http.get("/api/cube", params=dict(BARNARD, preview=value)).status_code == 422


# ---------- TAP reuse ----------

def test_detector_query_reuses_a_fresh_all_detector_answer(tmp_path):
    from backend.tests.test_coverage import COUNTS, tap_csv
    from backend.tests.test_irsa import FakeIrsa
    fake = FakeIrsa([(200, tap_csv(COUNTS))])
    c = irsa.IrsaClient(tmp_path, session_factory=fake.factory, sleep=lambda s: None)
    every = c.query_images(269.4464, 4.7666)  # what /api/coverage asks
    d6 = c.query_images(269.4464, 4.7666, "D6")
    assert len(fake.calls) == 1 and len(d6) == 45 and all(r["band"] == "SPHEREx-D6" for r in d6)
    assert d6 == [r for r in every if r["band"] == "SPHEREx-D6"]


def test_preview_cutouts_get_one_attempt_full_pass_all_retries(make):
    http, client = make()
    client.full_gate.set()
    assert wait_for(http, dict(BARNARD, preview=1), "done").status_code == 200
    assert client.retries_seen == [jobs.PREVIEW_RETRIES, None]  # None = the client's default (3 retries)


def test_irsa_client_honours_a_per_call_retry_budget(tmp_path):
    from backend.tests.test_irsa import FakeIrsa
    fake = FakeIrsa([503] * 10)
    c = irsa.IrsaClient(tmp_path, session_factory=fake.factory, sleep=lambda s: None)
    out = c.fetch_cutouts([URI.format(1)], 269.4464, 4.7666, 0.05, retries=0)
    assert isinstance(out[0], irsa.IrsaError) and len(fake.calls) == 1   # one attempt, no backoff
    c.fetch_cutouts([URI.format(1)], 269.4464, 4.7666, 0.05)
    assert len(fake.calls) == 1 + 4                                        # default: 1 + 3 retries
