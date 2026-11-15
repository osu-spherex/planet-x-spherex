"""Task C-12 (issue #99): cutouts IRSA did not deliver are asked for again; a cube that still misses
images says so (n_failed) and is refilled in the background by a later request."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from backend import irsa, jobs
from backend.app import create_app
from backend.limits import Limiter
from backend.tests.test_cube_api import BARNARD, URI, FakeClient, fake_builder, poll
from backend.tests.test_measure_api import fake_measurer, poll_measure


class FlakyClient(FakeClient):
    """Each uri in `flaky` fails its first `times` downloads, then works (IRSA on 11/14)."""

    def __init__(self, cache_dir, flaky=(), times=1, **kw):
        super().__init__(cache_dir, **kw)
        self.left = {u: times for u in flaky}
        self.batches = []

    def fetch_cutouts(self, uris, ra, dec, size_deg=0.05, progress=None, retries=None):
        self.batches.append(list(uris))
        out = []
        for i, u in enumerate(uris, 1):
            if self.left.get(u, 0) > 0:
                self.left[u] -= 1
                out.append(irsa.IrsaError("cutout: gave up after 4 attempts (503)", 503))
            else:
                p = self.cache_dir / "cutouts" / u.rsplit("/", 1)[1]
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b"x")
                out.append(p)
            if progress:
                progress(i, len(uris))
        return out


FLAKY = [URI.format(i) for i in (1, 2, 3)]


@pytest.fixture
def make(tmp_path):
    def make(**kw):
        client = FlakyClient(tmp_path / "cache", n_images=10, **kw)
        app = create_app(client=client, cubes_dir=tmp_path / "cubes", builder=fake_builder,
                         measurer=fake_measurer, limiter=Limiter(10, 100))
        return TestClient(app), client
    return make


def test_three_missing_come_on_the_second_pass(make):
    http, client = make(flaky=FLAKY, times=1)
    cube = poll(http, BARNARD).json()
    assert cube["status"] == "done" and cube["shape"][0] == 10
    assert cube["n_failed"] == 0 and cube["n_frames"] == 10 and cube["n_images"] == 10
    assert len(client.batches) == 2 and sorted(client.batches[1]) == sorted(FLAKY)  # only the missing ones again


def test_still_missing_is_reported_and_refilled_later(make, monkeypatch):
    http, client = make(flaky=FLAKY, times=2)
    cube = poll(http, BARNARD).json()
    assert cube["shape"][0] == 7 and cube["n_failed"] == 3 and cube["n_frames"] == 10
    # soon after: the same incomplete cube, nothing new started
    again = http.get("/api/cube", params=BARNARD)
    assert again.status_code == 200 and again.json()["n_failed"] == 3 and len(client.batches) == 2
    # minutes later: still answered at once with what there is, and a refill starts behind it
    monkeypatch.setattr(jobs, "REFILL_AFTER_S", 0.0)
    r = http.get("/api/cube", params=BARNARD)
    assert r.status_code == 200 and r.json()["n_failed"] == 3
    t = time.time()
    while time.time() - t < 5:
        now = http.get("/api/cube", params=BARNARD).json()
        if now.get("n_failed") == 0:
            break
        time.sleep(0.02)
    assert now["n_failed"] == 0 and now["shape"][0] == 10


def test_complete_cubes_are_never_refilled(make, monkeypatch):
    http, client = make()
    assert poll(http, BARNARD).json()["n_failed"] == 0
    monkeypatch.setattr(jobs, "REFILL_AFTER_S", 0.0)
    for _ in range(3):
        http.get("/api/cube", params=BARNARD)
    time.sleep(0.2)
    assert len(client.batches) == 1


def test_one_refill_at_a_time(make, monkeypatch):
    http, client = make(flaky=FLAKY, times=10)   # never comes
    assert poll(http, BARNARD).json()["n_failed"] == 3
    monkeypatch.setattr(jobs, "REFILL_AFTER_S", 0.0)
    http.get("/api/cube", params=BARNARD)
    time.sleep(0.3)
    batches = len(client.batches)
    monkeypatch.setattr(jobs, "REFILL_AFTER_S", 3600.0)   # the refill just finished: not again so soon
    for _ in range(5):
        http.get("/api/cube", params=BARNARD)
    time.sleep(0.2)
    assert len(client.batches) == batches


def test_measurement_reports_missing_images(make):
    http, _ = make(flaky=FLAKY, times=2)
    m = poll_measure(http, BARNARD).json()
    assert m["n_failed"] == 3 and m["n_frames"] == 10
