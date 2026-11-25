from tokengrill.core.config import new_provider
from tokengrill.core.topbar import is_shown, limit_key, ordered_limits, set_automatic, shown_limits, toggle_limit
from tokengrill.core.types import CanonicalQuotaWindow, ProviderInstance, TopBarSelection, UsageWindow


def window(window_id: str, canonical: CanonicalQuotaWindow, percent: float) -> UsageWindow:
    return {
        "id": window_id,
        "canonicalWindow": canonical,
        "label": window_id,
        "used": None,
        "limit": None,
        "percent": percent,
        "resetAt": None,
        "durationSeconds": None,
        "unit": None,
        "pace": None,
    }


FIVE_HOUR = window("five_hour", "five-hour", 0.6)
WEEKLY = window("seven_day", "weekly", 0.88)
OPUS = window("seven_day_opus", "other", 0.42)
AUTO: TopBarSelection = {"automatic": True, "limits": []}


def account(top_bar: TopBarSelection) -> ProviderInstance:
    return {**new_provider("claude", "claude-code", "~/.claude"), "topBar": top_bar}


def test_limit_keys_are_canonical_windows_or_the_window_id_for_other_limits() -> None:
    assert limit_key(FIVE_HOUR) == "five-hour"
    assert limit_key(OPUS) == "seven_day_opus"


def test_first_click_while_automatic_keeps_the_shown_limit_and_adds_the_clicked_one() -> None:
    result = toggle_limit(account(AUTO), "five-hour", [FIVE_HOUR, WEEKLY])
    assert result["topBar"] == {"automatic": False, "limits": ["five-hour", "weekly"]}


def test_first_click_on_the_automatic_limit_pins_it() -> None:
    result = toggle_limit(account(AUTO), "weekly", [FIVE_HOUR, WEEKLY])
    assert result["topBar"] == {"automatic": False, "limits": ["weekly"]}


def test_later_clicks_toggle_and_unticking_the_last_limit_hides_the_account() -> None:
    windows = [FIVE_HOUR, WEEKLY]
    added = toggle_limit(account({"automatic": False, "limits": ["weekly"]}), "five-hour", windows)
    assert added["topBar"] == {"automatic": False, "limits": ["five-hour", "weekly"]}
    removed = toggle_limit(account({"automatic": False, "limits": ["weekly"]}), "weekly", windows)
    assert removed["topBar"] == {"automatic": False, "limits": []}
    assert is_shown(removed) is False


def test_toggling_does_not_change_the_given_instance() -> None:
    original = account({"automatic": False, "limits": ["weekly"]})
    toggle_limit(original, "five-hour", [FIVE_HOUR, WEEKLY])
    assert original["topBar"] == {"automatic": False, "limits": ["weekly"]}


def test_limits_follow_the_popup_order() -> None:
    windows = [OPUS, WEEKLY, FIVE_HOUR]
    assert [limit_key(w) for w in ordered_limits(windows)] == ["five-hour", "weekly", "seven_day_opus"]
    shown = shown_limits(account({"automatic": False, "limits": ["weekly", "seven_day_opus", "five-hour"]}), windows)
    assert [limit_key(w) for w in shown] == ["five-hour", "weekly", "seven_day_opus"]


def test_toggling_without_readings_appends_the_key() -> None:
    result = toggle_limit(account({"automatic": False, "limits": ["weekly"]}), "five-hour")
    assert result["topBar"] == {"automatic": False, "limits": ["weekly", "five-hour"]}


def test_automatic_shows_the_limit_closest_to_running_out() -> None:
    assert shown_limits(account(AUTO), [FIVE_HOUR, WEEKLY]) == [WEEKLY]


def test_turning_automatic_on_clears_the_ticks_turning_it_off_keeps_them() -> None:
    assert set_automatic(account({"automatic": False, "limits": ["weekly"]}), True)["topBar"] == AUTO
    assert set_automatic(account(AUTO), False)["topBar"] == {"automatic": False, "limits": []}
    assert set_automatic(account({"automatic": False, "limits": ["weekly"]}), False)["topBar"]["limits"] == ["weekly"]


def test_is_shown_of_an_account_and_of_one_limit() -> None:
    assert is_shown(account(AUTO)) is True
    assert is_shown(account({"automatic": False, "limits": []})) is False
    ticked = account({"automatic": False, "limits": ["weekly"]})
    assert is_shown(ticked, "weekly") is True
    assert is_shown(ticked, "five-hour") is False
    assert is_shown(account(AUTO), "weekly") is False
