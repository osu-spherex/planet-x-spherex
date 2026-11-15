import pytest

from backend import jobs


@pytest.fixture(autouse=True)
def no_refetch_wait(monkeypatch):
    """The second pass for missing cutouts waits 5 s in production (task C-12); not in tests."""
    monkeypatch.setattr(jobs, "REFETCH_WAIT_S", 0.0)
