"""/api/measure tests (task C-04). No network and no real measurement: the fake IRSA client from
test_cube_api and a fake measurer stand in. Real numbers are checked by hand on Barnard's Star
(PR description), not here."""
import json
import math
import sys
import threading

import pytest
from fastapi.testclient import TestClient

from backend import jobs
from backend.app import create_app
from backend.tests.test_cube_api import BARNARD, FakeClient, fake_builder, poll

MOTION = dict(pm_ra=-0.8, pm_dec=10.4, err_ra=0.4, err_dec=0.2, err=0.4, sys_ra=0.5, sys_dec=0.1, n_epochs=4)


def fake_measurer(files, ra, dec, band):
    return dict(ra=ra, dec=dec, band="D1", n_frames=len(files), n_used=len(files), saturated=True,
                epochs=[dict(epoch=0, mjd=60914.2, n=len(files), ra=ra, dec=dec, dra_arcsec=0.0, ddec_arcsec=0.0,
                             err_ra=0.3, err_dec=0.1, err_arcsec=0.2)],
                motion=MOTION, photometry=[dict(id=f.name, mjd=60914.2, epoch=0, lam_um=0.75, flux=1.0, err=0.1,
                                                ok=True, why="") for f in files])


class RecordingClient(FakeClient):
    """FakeClient that also records where and how big the cutouts were."""

    def fetch_cutouts(self, uris, ra, dec, size_deg=0.05, progress=None, retries=None):
        self.calls = getattr(self, "calls", []) + [(round(ra, 7), round(dec, 7), size_deg)]
        return super().fetch_cutouts(uris, ra, dec, size_deg, progress, retries)


@pytest.fixture
def make(tmp_path):
    def make(measurer=fake_measurer, cubes_dir=None, client_cls=FakeClient, **client_kw):
        client = client_cls(tmp_path / "cache", **client_kw)
        app = create_app(client=client, cubes_dir=cubes_dir or tmp_path / "cubes", builder=fake_builder,
                         measurer=measurer, max_frames=120)
        return TestClient(app), client
    return make


def poll_measure(http, params, timeout=5):
    import time
    t = time.time()
    while True:
        r = http.get("/api/measure", params=params)
        if r.status_code != 202 or time.time() - t > timeout:
            return r
        time.sleep(0.02)


def test_measure_reports_progress_then_result(make):
    gate = threading.Event()
    http, _ = make(gate=gate)
    r = http.get("/api/measure", params=BARNARD)
    assert r.status_code == 202 and r.json()["status"] in ("queued", "searching", "downloading")
    gate.set()
    r = poll_measure(http, BARNARD)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "done" and body["motion"] == MOTION
    assert len(body["epochs"]) == 1 and len(body["photometry"]) == 5
    assert body["saturated"] is True  # passed through unchanged


def test_no_source_is_an_answer_not_an_error(make):
    def nothing_there(files, ra, dec, band):
        return dict(ra=ra, dec=dec, band="D1", n_frames=len(files), n_used=0, saturated=False,
                    epochs=[], motion=None, photometry=[])
    http, _ = make(measurer=nothing_there)
    r = poll_measure(http, BARNARD)
    assert r.status_code == 200
    assert r.json()["epochs"] == [] and r.json()["motion"] is None


def test_measure_and_cube_download_the_same_cutouts(make):
    """Same centre and size, so IrsaClient's disk cache serves the second job without IRSA."""
    http, client = make(client_cls=RecordingClient)
    assert poll(http, BARNARD).status_code == 200
    assert poll_measure(http, dict(BARNARD, ra=269.44641)).status_code == 200  # rounds to the same key
    assert len(client.calls) == 2 and client.calls[0] == client.calls[1]


def test_finished_measurement_is_reused(make):
    http, client = make()
    assert poll_measure(http, BARNARD).status_code == 200
    calls = client.tap_calls
    assert http.get("/api/measure", params=BARNARD).status_code == 200 and client.tap_calls == calls


def test_nan_in_result_is_an_error_not_broken_json(make):
    def leaky(files, ra, dec, band):
        return {**fake_measurer(files, ra, dec, band), "motion": dict(MOTION, pm_ra=math.nan)}
    http, _ = make(measurer=leaky)
    r = poll_measure(http, BARNARD)
    assert r.status_code == 502 and r.json()["status"] == "error"


def test_measurer_crash_is_reported(make):
    def broken(*a):
        raise ValueError("fit diverged")
    http, _ = make(measurer=broken)
    r = poll_measure(http, BARNARD)
    assert r.status_code == 502 and "fit diverged" in r.json()["message"]


def test_without_pipeline_says_unavailable(make):
    http, client = make(measurer=None)
    r = poll_measure(http, BARNARD)
    assert r.status_code == 503 and r.json()["status"] == "unavailable" and client.tap_calls == 0
    assert http.get("/health").json()["measure_pipeline"] is False


def test_no_images_is_404(make):
    http, _ = make(n_images=0)
    r = poll_measure(http, BARNARD)
    assert r.status_code == 404 and r.json()["status"] == "empty"


@pytest.mark.parametrize("params", [dict(BARNARD, band="D0"), dict(BARNARD, dec=95), {"ra": 1}])
def test_bad_parameters_are_422(make, params):
    http, _ = make()
    assert http.get("/api/measure", params=params).status_code == 422


def test_static_measure_json_is_served(make, tmp_path):
    d = tmp_path / "cubes" / "barnard" / "D1"
    d.mkdir(parents=True)
    (d / "measure.json").write_text(json.dumps({"object": "barnard", "motion": {"status": "ok", **MOTION}}))
    http, _ = make()
    r = http.get("/cubes/barnard/D1/measure.json")
    assert r.status_code == 200 and r.json()["motion"]["pm_dec"] == 10.4


# ---------- which measurement function is used ----------

def test_default_measurer_is_photometry_with_motion():
    from data import photometry
    assert jobs.default_measurer() is photometry.measure_from_files


def test_motion_only_fallback_adds_empty_photometry(monkeypatch, tmp_path):
    import data
    from data import motion
    monkeypatch.setitem(sys.modules, "data.photometry", None)  # import now raises ImportError ...
    monkeypatch.delattr(data, "photometry", raising=False)     # ... also when already imported
    monkeypatch.setattr(motion, "measure_shift_from_files",
                        lambda files, ra, dec, band: dict(epochs=[], motion=None, saturated=False))
    fn = jobs.default_measurer()
    assert fn([tmp_path / "x.fits"], 1.0, 2.0, "D1") == dict(epochs=[], motion=None, saturated=False, photometry=[])
