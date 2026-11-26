from pathlib import Path

from tokengrill.core.config import new_provider
from tokengrill.core.types import ErrorInfo, ProviderSnapshot, ServiceState, UsageWindow
from tokengrill.statusview import error_text, render_status

NOW = 1_800_000_000_000
MINUTE = 60_000


def _window(label: str, percent: float | None, reset_in_minutes: int | None) -> UsageWindow:
    return {
        "id": label,
        "canonicalWindow": "other",
        "label": label,
        "used": None,
        "limit": None,
        "percent": percent,
        "resetAt": None if reset_in_minutes is None else NOW + reset_in_minutes * MINUTE,
        "durationSeconds": None,
        "unit": None,
        "pace": None,
    }


def _snapshot(account_id: str, **changes: object) -> ProviderSnapshot:
    zero = {"input": 0, "output": 0, "cachedInput": 0, "cacheWrite": 0, "reasoning": 0, "total": 0}
    base: ProviderSnapshot = {
        "providerId": account_id,
        "state": "ready",
        "lastUpdated": NOW - 3 * MINUTE,
        "errorInfo": None,
        "plan": None,
        "account": None,
        "windows": [],
        "balance": None,
        "totals": zero,
        "todayTotals": zero,
        "monthTotals": zero,
        "todayCost": None,
        "monthCost": None,
        "quotaFetchedAt": None,
        "localHistoryUpdatedAt": None,
        "resetCredits": None,
        "pace": None,
    }
    return {**base, **changes}  # type: ignore[typeddict-item]


def _state() -> ServiceState:
    codex = {**new_provider("codex", "codex-cli", "/h/codex"), "id": "a1", "displayName": "Work"}
    deepseek = {**new_provider("deepseek", "keyring", ""), "id": "a2", "displayName": "DeepSeek"}
    kiro = {**new_provider("kiro", "kiro-cli", "/h/kiro"), "id": "a3", "displayName": "Kiro"}
    error: ErrorInfo = {
        "code": "auth-expired",
        "messageId": "kiro.auth-expired",
        "params": {},
        "recovery": "reauthenticate",
    }
    return {
        "schema": 1,
        "apiVersion": 1,
        "serviceVersion": "0.5.0",
        "paused": False,
        "settings": {
            "refreshIntervalSeconds": 300,
            "alertsEnabled": True,
            "alertStepPercent": 10,
            "journalDiagnostics": False,
        },
        "accounts": [codex, deepseek, kiro],  # type: ignore[list-item]
        "snapshots": {
            "a1": _snapshot(
                "a1",
                windows=[_window("Five-hour", 0.28, 125), _window("Weekly", 0.614, 3 * 1440 + 90)],
            ),
            "a2": _snapshot("a2", balance={"amount": 12.5, "currency": "USD"}, lastUpdated=NOW - 2 * 60 * MINUTE),
            "a3": _snapshot("a3", state="error", errorInfo=error, lastUpdated=None),
        },
        "runtime": {},
    }


def test_render_status_matches_golden() -> None:
    golden = (Path(__file__).parent / "fixtures" / "status.txt").read_text(encoding="ascii")
    assert render_status(_state(), NOW) == golden
    assert golden.isascii()


def test_error_text_formats_params_and_falls_back() -> None:
    path: ErrorInfo = {"code": "auth-missing", "messageId": "config.no-credentials", "params": {}, "recovery": "none"}
    assert error_text(path) == "No credentials were found at {path}."
    path["params"] = {"path": "/x"}
    assert error_text(path) == "No credentials were found at /x."
    unknown: ErrorInfo = {"code": "http", "messageId": "nope.nothing", "params": {}, "recovery": "none"}
    assert error_text(unknown) == "http"


def test_render_status_without_accounts() -> None:
    state = _state()
    state["accounts"] = []
    assert render_status(state, NOW) == "No accounts are set up.\n"
