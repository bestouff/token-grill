import json

from tokengrill.core.readings import restored_snapshot, snapshot_fingerprint
from tokengrill.core.types import ProviderSnapshot, UsageWindow, empty_snapshot
from tokengrill.storage.readings import StoredReading, parse_stored_reading, stored_reading

WINDOW: UsageWindow = {
    "id": "weekly",
    "canonicalWindow": "weekly",
    "label": "Weekly",
    "used": None,
    "limit": None,
    "percent": 0.4,
    "resetAt": 1795000000000,
    "durationSeconds": None,
    "unit": None,
    "pace": None,
}
SNAPSHOT: ProviderSnapshot = {
    **empty_snapshot("a"),
    "state": "ready",
    "lastUpdated": 1794000000000,
    "plan": "Pro",
    "account": "person@example.com",
    "windows": [WINDOW],
    "quotaFetchedAt": 1794000000000,
}


def reading() -> StoredReading:
    found = stored_reading(SNAPSHOT)
    assert found is not None
    return found


def test_a_stored_reading_keeps_the_limits_and_leaves_out_the_email_address() -> None:
    found = reading()
    assert "example.com" not in json.dumps(found)
    assert found["plan"] == "Pro"
    assert found["fetchedAt"] == 1794000000000
    assert stored_reading({**SNAPSHOT, "quotaFetchedAt": None}) is None


def test_a_stored_reading_round_trips_and_comes_back_stale_with_its_age() -> None:
    parsed = parse_stored_reading(json.loads(json.dumps(reading())))
    assert parsed is not None
    restored = restored_snapshot("a", parsed)
    assert restored["state"] == "stale"
    assert restored["providerId"] == "a"
    assert restored["quotaFetchedAt"] == 1794000000000
    assert restored["lastUpdated"] == 1794000000000
    assert restored["windows"] == [WINDOW]
    assert restored["account"] is None
    assert restored["pace"] is None


def test_restored_reset_credits_are_marked_stale() -> None:
    credits = {"availableCount": 1, "credits": [], "fetchedAt": 5, "stale": False, "error": None}
    parsed = parse_stored_reading({**reading(), "resetCredits": credits})
    assert parsed is not None
    restored = restored_snapshot("a", parsed)
    assert restored["resetCredits"] == {**credits, "stale": True}


def test_a_damaged_entry_is_dropped_as_a_whole() -> None:
    base = dict(reading())
    assert parse_stored_reading(None) is None
    assert parse_stored_reading({**base, "fetchedAt": "yesterday"}) is None
    assert parse_stored_reading({**base, "windows": [{**WINDOW, "percent": "40"}]}) is None
    assert parse_stored_reading({**base, "windows": [{**WINDOW, "canonicalWindow": "daily"}]}) is None
    assert parse_stored_reading({**base, "balance": {"amount": "x", "currency": "USD"}}) is None


def test_fingerprint_of_nothing_is_empty() -> None:
    assert snapshot_fingerprint(None) == ""


def test_fingerprint_ignores_fetch_times_errors_and_state() -> None:
    other: ProviderSnapshot = {**SNAPSHOT, "lastUpdated": 1, "quotaFetchedAt": 1, "state": "stale"}
    assert snapshot_fingerprint(other) == snapshot_fingerprint(SNAPSHOT)


def test_fingerprint_changes_with_the_data_users_care_about() -> None:
    base = snapshot_fingerprint(SNAPSHOT)
    assert snapshot_fingerprint({**SNAPSHOT, "plan": "Max"}) != base
    assert snapshot_fingerprint({**SNAPSHOT, "windows": [{**WINDOW, "percent": 0.5}]}) != base
    assert snapshot_fingerprint({**SNAPSHOT, "todayCost": 1.5}) != base


def test_fingerprint_counts_reset_credits_by_count_and_list_not_staleness() -> None:
    credits = {"availableCount": 1, "credits": [], "fetchedAt": 5, "stale": False, "error": None}
    one: ProviderSnapshot = {**SNAPSHOT, "resetCredits": credits}
    two: ProviderSnapshot = {**SNAPSHOT, "resetCredits": {**credits, "fetchedAt": 9, "stale": True}}
    assert snapshot_fingerprint(one) == snapshot_fingerprint(two)
    assert snapshot_fingerprint(one) != snapshot_fingerprint(SNAPSHOT)
