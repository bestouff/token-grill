from tokengrill.core.timemath import duration_until, format_duration


def _format(ms: float, compact: bool = False) -> str:
    parts = duration_until(ms, 0)
    assert parts is not None
    return format_duration(parts, compact)


def test_reset_countdown_uses_days_only_when_needed() -> None:
    assert _format(6 * 86400000 + 4 * 3600000 + 3 * 60000) == "6d 4h 3m"
    assert _format(6 * 86400000 + 4 * 3600000 + 3 * 60000, True) == "6d 4h"
    assert _format(2 * 86400000 + 14 * 60000) == "2d 0h 14m"
    assert _format(4 * 3600000 + 12 * 60000) == "4h 12m"
    assert _format(8 * 60000) == "8m"
    assert _format(30 * 1000) == "less than 1m"
    assert duration_until(None, 0) is None
    expired = duration_until(-1000, 0)
    assert expired is not None
    assert expired["expired"] is True


def test_duration_until_parts() -> None:
    assert duration_until(90 * 60000, 0) == {
        "expired": False,
        "totalMinutes": 90,
        "days": 0,
        "hours": 1,
        "minutes": 30,
    }
    assert duration_until(float("nan"), 0) is None
