from tokengrill.core.alerts import (
    NotificationCheckpoint,
    WindowState,
    check_milestone,
    clamp_step,
    migrate_notification_state,
    next_checkpoint,
    notification_bucket,
    notification_key,
    should_notify_low_balance,
    should_notify_milestone,
)
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow


def window(window_id: str, canonical: CanonicalQuotaWindow, percent: float | None, reset_at: int | None) -> UsageWindow:
    return {
        "id": window_id,
        "canonicalWindow": canonical,
        "label": window_id,
        "used": None,
        "limit": None,
        "percent": percent,
        "resetAt": reset_at,
        "durationSeconds": None,
        "unit": None,
        "pace": None,
    }


def checkpoint(identity: str, bucket: int, step: int = 10) -> NotificationCheckpoint:
    return {"resetIdentity": identity, "lastNotifiedBucket": bucket, "configuredStep": step}


def test_first_observation_seeds_silently_and_a_later_bucket_crossing_notifies_once() -> None:
    assert should_notify_milestone(None, "weekly:reset-1", 6, 10) is False
    previous = checkpoint("weekly:reset-1", 6)
    assert should_notify_milestone(previous, "weekly:reset-1", 6, 10) is False
    assert should_notify_milestone(previous, "weekly:reset-1", 7, 10) is True
    assert should_notify_milestone(previous, "weekly:reset-2", 7, 10) is False
    assert should_notify_milestone(previous, "weekly:reset-1", 7, 20) is False, "a changed step seeds"


def test_steps_are_clamped_and_buckets_normalized() -> None:
    assert clamp_step(24) == 25
    assert clamp_step(1) == 5
    assert clamp_step(90) == 50
    assert clamp_step(12.5) == 15, "halves round up as Math.round"
    assert notification_bucket(0.68, 10) == 6
    assert notification_bucket(1.2, 10) == 10
    assert notification_bucket(0.26, 24) == 1


def test_each_shown_limit_has_its_own_state_key() -> None:
    assert notification_key("a", window("five_hour", "five-hour", 0.1, None)) == "a:five-hour"
    assert notification_key("a", window("seven_day_opus", "other", 0.1, None)) == "a:seven_day_opus"


def test_legacy_state_moves_to_the_per_limit_keys() -> None:
    migrated = migrate_notification_state(
        {
            "a:selected-limit": {
                "providerId": "a",
                "resetIdentity": "weekly:1794200000000",
                "lastNotifiedBucket": 6,
                "configuredStep": 10,
            },
            "b:selected-limit": {
                "providerId": "b",
                "resetIdentity": "five-hour:unknown",
                "lastNotifiedBucket": 2,
                "configuredStep": 10,
            },
            "c:monthly": {
                "providerId": "c",
                "resetIdentity": "monthly:1",
                "lastNotifiedBucket": 1,
                "configuredStep": 10,
            },
        }
    )
    assert sorted(migrated) == ["a:weekly", "b:five-hour", "c:monthly"]
    assert migrated["a:weekly"]["lastNotifiedBucket"] == 6
    assert migrated["a:weekly"]["resetIdentity"] == "weekly:1794199980000"


def test_a_damaged_legacy_entry_is_dropped() -> None:
    assert migrate_notification_state({"a:selected-limit": {"providerId": "a", "lastNotifiedBucket": 2}}) == {}


def test_a_low_balance_alerts_once_when_it_drops_below_the_warning() -> None:
    assert should_notify_low_balance(None, True) is False, "the first reading only seeds"
    assert should_notify_low_balance(False, True) is True
    assert should_notify_low_balance(True, True) is False
    assert should_notify_low_balance(True, False) is False


def test_a_limit_without_a_reset_time_starts_over_when_its_reading_falls() -> None:
    previous = checkpoint("other:unknown", 8)
    assert next_checkpoint(previous, "other:unknown", 2, 10, False)["lastNotifiedBucket"] == 2
    assert next_checkpoint(previous, "other:unknown", 9, 10, False)["lastNotifiedBucket"] == 9
    timed = checkpoint("weekly:1", 8)
    assert next_checkpoint(timed, "weekly:1", 2, 10, True)["lastNotifiedBucket"] == 8
    assert next_checkpoint(timed, "weekly:2", 2, 10, True)["lastNotifiedBucket"] == 2


def test_each_limit_keeps_its_own_milestones_under_a_key_legacy_state_migrates_to() -> None:
    weekly = window("seven_day", "weekly", 0.62, 1794200000000)
    seeded = check_milestone(None, weekly, 10)
    assert seeded.notify is False
    assert seeded.checkpoint == checkpoint("weekly:1794199980000", 6)
    crossed = check_milestone(seeded.checkpoint, {**weekly, "percent": 0.71}, 10)
    assert crossed.notify is True
    assert crossed.consumed == 0.71
    legacy: WindowState = {**checkpoint("weekly:1794200000000", 6), "providerId": "a"}
    migrated = migrate_notification_state({"a:selected-limit": legacy})
    assert notification_key("a", weekly) == "a:weekly"
    assert check_milestone(migrated["a:weekly"], weekly, 10).notify is False, "the upgrade does not re-alert"


def test_a_reset_time_that_drifts_by_milliseconds_is_the_same_reset() -> None:
    five = window("five_hour", "five-hour", 0.82, 1794271200177)
    seeded = check_milestone(None, five, 10)
    later = {**five, "resetAt": 1794271199875, "percent": 0.91}
    assert check_milestone(seeded.checkpoint, later, 10).notify is True
