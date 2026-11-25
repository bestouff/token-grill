import json
import subprocess
import sys

import pytest

pytestmark = pytest.mark.integration

TIMEOUT = 30


def run_status(env: dict[str, str], *flags: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "tokengrill", "status", *flags],
        env=env,
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
        check=False,
    )


def test_status_json_is_state(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    result = run_status(env, "--json")
    assert result.returncode == 0, result.stderr
    state = json.loads(result.stdout)
    assert state["schema"] == 1
    assert state["accounts"] == []


def test_status_text_with_refresh(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    result = run_status(env, "--refresh")
    assert result.returncode == 0, result.stderr
    assert result.stdout == "No accounts are set up.\n"


def test_status_without_an_installed_service_hints_at_setup(env: dict[str, str], bus_address: str) -> None:
    result = run_status(env)
    assert result.returncode == 1
    assert "tokengrill setup" in result.stderr
    assert "Traceback" not in result.stderr
