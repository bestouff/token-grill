from datetime import UTC, datetime

from tokengrill.core.config import new_provider
from tokengrill.core.pace import BAND, MIN_ELAPSED, account_pace, pace_lead, pace_state, runs_out_at, with_pace
from tokengrill.core.types import ProviderInstance, ProviderSnapshot, UsageWindow, empty_snapshot

HOUR = 3600 * 1000
NOW = int(datetime(2026, 11, 23, 12, 0, tzinfo=UTC).timestamp() * 1000)


def window(
    percent: float | None, reset_at: int | None = NOW + int(2.5 * HOUR), duration: int | None = 5 * 3600
) -> UsageWindow:
    """A five-hour window that is halfway through."""
    return {
        "id": "five-hour",
        "canonicalWindow": "five-hour",
        "label": "5h",
        "used": None,
        "limit": None,
        "percent": percent,
        "resetAt": reset_at,
        "durationSeconds": duration,
        "unit": None,
        "pace": None,
    }


def lead(value: UsageWindow) -> float | None:
    return pace_lead(value, NOW)


def state_of(value: UsageWindow) -> str:
    found = lead(value)
    assert found is not None
    return pace_state(found)


def test_constants() -> None:
    assert BAND == 0.1
    assert MIN_ELAPSED == 0.1


def test_pace_compares_usage_with_the_share_of_the_window_that_has_passed() -> None:
    assert state_of(window(0.8)) == "high"
    assert state_of(window(0.55)) == "on-track"
    assert state_of(window(0.45)) == "on-track"
    assert state_of(window(0.2)) == "low"


def test_window_without_length_or_at_its_start_or_end_has_no_pace() -> None:
    assert lead(window(0.5, duration=None)) is None
    assert lead(window(0.5, reset_at=None)) is None
    assert lead(window(None)) is None
    assert lead(window(0.5, reset_at=NOW + int(4.9 * HOUR))) is None
    assert lead(window(0.5, reset_at=NOW - 1)) is None


def test_runs_out_at_names_the_time_the_limit_is_used_up() -> None:
    # 80% used after 2.5 hours runs out after 3.125 hours, at 12:37:30.
    assert runs_out_at(window(0.8), NOW) == NOW - int(2.5 * HOUR) + int(3.125 * HOUR)
    assert runs_out_at(window(1.0), NOW) == NOW
    assert runs_out_at(window(0.0), NOW) is None
    assert runs_out_at(window(None), NOW) is None
    assert runs_out_at(window(0.8, duration=None), NOW) is None


def test_account_pace_is_that_of_the_most_pressed_limit() -> None:
    assert account_pace([window(0.2), window(0.9)], NOW) == "high"
    assert account_pace([window(0.2), window(0.5)], NOW) == "on-track"
    assert account_pace([window(0.5, duration=None)], NOW) is None
    assert account_pace([], NOW) is None


def instance(**changes: object) -> ProviderInstance:
    return {**new_provider("codex", "codex-cli", "~/.codex"), **changes}  # type: ignore[typeddict-item]


def test_with_pace_fills_window_and_account_pace() -> None:
    snapshot: ProviderSnapshot = {**empty_snapshot("a"), "windows": [window(0.8), window(0.5, duration=None)]}
    paced = with_pace(snapshot, instance(), NOW)
    first, second = paced["windows"]
    assert first["pace"] == {"state": "high", "runsOutAt": NOW + int(0.625 * HOUR)}
    assert second["pace"] is None
    assert paced["pace"] == {"state": "high", "runsOutAt": NOW + int(0.625 * HOUR)}
    # The input is left alone.
    assert snapshot["windows"][0]["pace"] is None


def test_with_pace_a_used_up_window_has_pace_without_a_time() -> None:
    paced = with_pace({**empty_snapshot("a"), "windows": [window(1.0)]}, instance(), NOW)
    assert paced["windows"][0]["pace"] == {"state": "high", "runsOutAt": None}


def test_with_pace_on_track_and_low_carry_no_time() -> None:
    paced = with_pace({**empty_snapshot("a"), "windows": [window(0.5), window(0.1)]}, instance(), NOW)
    assert [w["pace"] for w in paced["windows"]] == [
        {"state": "on-track", "runsOutAt": None},
        {"state": "low", "runsOutAt": None},
    ]


def test_account_pace_covers_only_the_shown_limits() -> None:
    weekly: UsageWindow = {**window(0.9), "id": "weekly", "canonicalWindow": "weekly"}
    snapshot: ProviderSnapshot = {**empty_snapshot("a"), "windows": [window(0.2), weekly]}
    automatic = with_pace(snapshot, instance(), NOW)
    assert automatic["pace"] == {"state": "high", "runsOutAt": runs_out_at(weekly, NOW)}
    pinned = with_pace(snapshot, instance(topBar={"automatic": False, "limits": ["five-hour"]}), NOW)
    assert pinned["pace"] == {"state": "low", "runsOutAt": None}
    none_shown = with_pace(snapshot, instance(topBar={"automatic": False, "limits": []}), NOW)
    assert none_shown["pace"] is None
