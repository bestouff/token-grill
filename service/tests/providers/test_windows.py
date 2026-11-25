from datetime import UTC, datetime

from tokengrill.providers.windows import FIVE_HOURS, WEEK, claim_type, month_before, named_length, window_label


def ms(text: str) -> int:
    return int(datetime.fromisoformat(text).replace(tzinfo=UTC).timestamp() * 1000)


def test_named_length() -> None:
    assert named_length("five-hour") == FIVE_HOURS == 18000
    assert named_length("weekly") == WEEK == 604800
    assert named_length("monthly") is None
    assert named_length("other") is None


def test_month_before_follows_calendar_months() -> None:
    assert month_before(None) is None
    assert month_before(ms("2026-08-15T00:00:00")) == 31 * 86400
    assert month_before(ms("2026-03-15T00:00:00")) == 28 * 86400


def test_month_before_overflows_like_date_set_utc_month() -> None:
    # 31 March minus a month is "31 February", which Date rolls to 3 March.
    assert month_before(ms("2026-03-31T00:00:00")) == 28 * 86400
    assert month_before(ms("2026-01-31T00:00:00")) == 31 * 86400


def test_claim_type_keeps_one_window_of_each_type() -> None:
    claimed: set[str] = set()
    assert claim_type(claimed, "weekly", "Pro") == {"canonicalWindow": "weekly", "label": "Weekly"}
    assert claim_type(claimed, "weekly", "Opus") == {"canonicalWindow": "other", "label": "Opus - Weekly"}
    assert claim_type(claimed, "other", "Extra") == {"canonicalWindow": "other", "label": "Extra"}


def test_window_label() -> None:
    assert window_label("monthly", "x") == "Monthly"
    assert window_label("other", "x") == "x"
