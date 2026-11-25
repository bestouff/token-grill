from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def private_runtime_and_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Starting a runtime sweeps and tightens the private-copy folder, so no test may reach the real one."""
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "runtime-dir"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache-home"))
