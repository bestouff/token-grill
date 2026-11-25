"""When a limit or a balance earns an alert; the extension writes the text."""

from dataclasses import dataclass
from typing import Any, TypedDict

from tokengrill.core.json_util import is_record, to_number
from tokengrill.core.topbar import limit_key
from tokengrill.core.types import UsageWindow

_MINUTE_MS = 60_000
_LEGACY_SUFFIX = ":selected-limit"


class NotificationCheckpoint(TypedDict):
    resetIdentity: str
    lastNotifiedBucket: int
    configuredStep: int


class WindowState(NotificationCheckpoint):
    providerId: str


@dataclass(frozen=True)
class MilestoneCheck:
    notify: bool
    consumed: float
    checkpoint: NotificationCheckpoint


def _round_half_up(value: float) -> int:
    """Math.round: halves go up."""
    return int((value + 0.5) // 1)


def clamp_step(step_percent: float) -> int:
    """Milestone steps are multiples of 5 between 5 % and 50 %."""
    return max(5, min(50, _round_half_up(step_percent / 5) * 5))


def notification_bucket(fraction: float, step_percent: float) -> int:
    consumed = max(0.0, min(100.0, fraction * 100))
    return int((consumed + 1e-6) // clamp_step(step_percent))


def notification_key(account_id: str, window: UsageWindow) -> str:
    return f"{account_id}:{limit_key(window)}"


def rounded_reset(reset_at: float) -> int:
    """Services report the same reset a few hundred milliseconds apart from one request to the next."""
    return _round_half_up(reset_at / _MINUTE_MS) * _MINUTE_MS


def migrate_notification_state(windows: dict[str, Any]) -> dict[str, WindowState]:
    """0.3.x kept one alert state per account; it moves to the key of the limit it followed.

    The file is our own but may be damaged; one bad entry must not stop the start.
    """
    migrated: dict[str, Any] = {}
    for key, state in windows.items():
        if not is_record(state) or not isinstance(state.get("resetIdentity"), str):
            continue
        if not key.endswith(_LEGACY_SUFFIX):
            migrated[key] = state
            continue
        identity: str = state["resetIdentity"]
        limit, _, rest = identity.partition(":")
        reset = rest.partition(":")[0]
        reset_at = to_number(reset) if reset != "" else None
        reset_identity = f"{limit}:{rounded_reset(reset_at)}" if reset_at is not None else identity
        if limit:
            migrated.setdefault(f"{key[: -len(_LEGACY_SUFFIX)]}:{limit}", {**state, "resetIdentity": reset_identity})
    return migrated


def next_checkpoint(
    previous: NotificationCheckpoint | None, reset_identity: str, bucket: int, step_percent: int, reset_known: bool
) -> NotificationCheckpoint:
    """A limit with a known reset starts over when the reset passes. One without a reset
    time, such as a prepaid balance after a top-up, starts over when its reading falls."""
    fell = not reset_known and previous is not None and bucket < previous["lastNotifiedBucket"]
    carried = (
        previous["lastNotifiedBucket"] if previous and previous["resetIdentity"] == reset_identity and not fell else 0
    )
    return {"resetIdentity": reset_identity, "lastNotifiedBucket": max(bucket, carried), "configuredStep": step_percent}


def should_notify_milestone(
    previous: NotificationCheckpoint | None, reset_identity: str, bucket: int, step_percent: int
) -> bool:
    """Startup, a newly shown limit and a changed step seed state silently: an alert is a crossing
    this service saw, not a historical milestone replayed when an account is first loaded."""
    if previous is None or previous["resetIdentity"] != reset_identity or previous["configuredStep"] != step_percent:
        return False
    return bucket >= 1 and bucket > previous["lastNotifiedBucket"]


def check_milestone(
    previous: NotificationCheckpoint | None, window: UsageWindow, step_percent: float
) -> MilestoneCheck:
    """One limit's reading against its last alert: whether to alert now, and the state to keep."""
    step = clamp_step(step_percent)
    consumed = max(0.0, min(1.0, window["percent"] or 0.0))
    bucket = notification_bucket(consumed, step)
    reset_at = window["resetAt"]
    reset_identity = f"{limit_key(window)}:{'unknown' if reset_at is None else rounded_reset(reset_at)}"
    return MilestoneCheck(
        notify=should_notify_milestone(previous, reset_identity, bucket, step),
        consumed=consumed,
        checkpoint=next_checkpoint(previous, reset_identity, bucket, step, reset_at is not None),
    )


def should_notify_low_balance(previous_low: bool | None, low: bool) -> bool:
    """Like milestones, the first reading after start only seeds the state."""
    return previous_low is False and low
