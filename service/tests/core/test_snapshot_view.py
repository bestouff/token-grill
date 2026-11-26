from typing import cast

from tokengrill.core.config import new_provider
from tokengrill.core.snapshot_view import snapshot_view
from tokengrill.core.types import (
    CanonicalQuotaWindow,
    ProviderInstance,
    ProviderRuntimeState,
    TopBarSelection,
    UsageWindow,
    WindowView,
    empty_snapshot,
)

NOW = 1_800_000_000_000
HOUR = 3600 * 1000


def window(window_id: str, canonical: CanonicalQuotaWindow, percent: float) -> UsageWindow:
    return {
        "id": window_id,
        "canonicalWindow": canonical,
        "label": window_id,
        "used": None,
        "limit": None,
        "percent": percent,
        "resetAt": NOW + int(2.5 * HOUR),
        "durationSeconds": 5 * 3600 if canonical == "five-hour" else None,
        "unit": None,
        "pace": None,
    }


OPUS = window("seven_day_opus", "other", 0.42)
WEEKLY = window("seven_day", "weekly", 0.88)
FIVE_HOUR = window("five_hour", "five-hour", 0.8)
AUTO: TopBarSelection = {"automatic": True, "limits": []}


def account(top_bar: TopBarSelection = AUTO, **changes: object) -> ProviderInstance:
    return cast(ProviderInstance, {**new_provider("claude", "claude-code", "~/.claude"), "topBar": top_bar, **changes})


def runtime(phase: str = "idle") -> ProviderRuntimeState:
    return cast(
        ProviderRuntimeState,
        {
            "phase": phase,
            "outcome": None,
            "completedAt": None,
            "sources": {"limits": None, "reset-credits": None, "history": None},
        },
    )


def test_windows_come_in_popup_order_with_their_top_bar_keys() -> None:
    view = snapshot_view({**empty_snapshot("a"), "windows": [OPUS, WEEKLY, FIVE_HOUR]}, account(), runtime(), NOW)
    windows = cast(list[WindowView], view["windows"])
    assert [(item["id"], item["key"]) for item in windows] == [
        ("five_hour", "five-hour"),
        ("seven_day", "weekly"),
        ("seven_day_opus", "seven_day_opus"),
    ]


def test_shown_limits_resolve_pick_automatically_to_the_most_used_limit() -> None:
    view = snapshot_view({**empty_snapshot("a"), "windows": [FIVE_HOUR, WEEKLY]}, account(), runtime(), NOW)
    assert view["shownLimits"] == ["weekly"]


def test_shown_limits_follow_the_ticked_limits_in_popup_order() -> None:
    ticked: TopBarSelection = {"automatic": False, "limits": ["seven_day_opus", "five-hour", "monthly"]}
    view = snapshot_view({**empty_snapshot("a"), "windows": [OPUS, WEEKLY, FIVE_HOUR]}, account(ticked), runtime(), NOW)
    assert view["shownLimits"] == ["five-hour", "seven_day_opus"]
    assert snapshot_view(empty_snapshot("a"), account(ticked), runtime(), NOW)["shownLimits"] == []


def test_the_pace_of_each_window_and_of_the_account_is_sent() -> None:
    view = snapshot_view({**empty_snapshot("a"), "windows": [FIVE_HOUR]}, account(), runtime(), NOW)
    assert view["windows"][0]["pace"] == {"state": "high", "runsOutAt": NOW - int(2.5 * HOUR) + int(3.125 * HOUR)}
    assert view["pace"] == view["windows"][0]["pace"]


def test_history_follows_the_account_and_the_refresh_phase() -> None:
    off = snapshot_view(empty_snapshot("a"), account(), runtime(), NOW)
    assert off["history"] == {"state": "off", "todayTokens": 0, "monthTokens": 0, "monthCost": None}
    scanning = snapshot_view(empty_snapshot("a"), account(localHistoryEnabled=True), runtime("scanning-history"), NOW)
    assert scanning["history"]["state"] == "updating"
    assert (
        snapshot_view(empty_snapshot("a"), account(localHistoryEnabled=True), None, NOW)["history"]["state"]
        == "waiting"
    )


def test_home_is_default_is_sent_for_the_sign_in() -> None:
    assert snapshot_view(empty_snapshot("a"), account(), runtime(), NOW)["homeIsDefault"] is True
    assert (
        snapshot_view(empty_snapshot("a"), account(accountHome="~/claude-work"), runtime(), NOW)["homeIsDefault"]
        is False
    )
