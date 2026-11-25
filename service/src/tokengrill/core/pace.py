"""How fast a limit is used compared with an even pace through its window."""

from typing import TypedDict

from tokengrill.core.topbar import shown_limits
from tokengrill.core.types import PaceLevel, PaceState, ProviderInstance, ProviderSnapshot, UsageWindow

# Within ten points of an even pace counts as on track; the first tenth of a
# window has too little usage behind it to tell.
BAND = 0.1
MIN_ELAPSED = 0.1


class _Paced(TypedDict):
    percent: float | None
    resetAt: int | None
    durationSeconds: int | None


def pace_lead(window: UsageWindow | _Paced, now: int) -> float | None:
    """How far usage is ahead of an even pace through the window, as a fraction of the limit.

    Only a window whose length the service reports has a pace.
    """
    percent = window["percent"]
    reset_at = window["resetAt"]
    duration = window["durationSeconds"]
    if percent is None or reset_at is None or duration is None:
        return None
    elapsed = 1 - (reset_at - now) / (duration * 1000)
    if elapsed < MIN_ELAPSED or elapsed >= 1:
        return None
    return percent - elapsed


def pace_state(lead: float) -> PaceLevel:
    if lead > BAND:
        return "high"
    return "low" if lead < -BAND else "on-track"


def runs_out_at(window: UsageWindow | _Paced, now: int) -> int | None:
    """When the limit runs out at the current rate, if that is before the reset."""
    percent = window["percent"]
    reset_at = window["resetAt"]
    duration = window["durationSeconds"]
    if percent is None or reset_at is None or duration is None or percent <= 0:
        return None
    start = reset_at - duration * 1000
    at = start + (now - start) / percent
    return round(at) if at < reset_at else None


def account_pace(windows: list[UsageWindow], now: int) -> PaceLevel | None:
    """The pace the top bar shows for an account: that of its most pressed shown limit."""
    leads = [lead for lead in (pace_lead(window, now) for window in windows) if lead is not None]
    return pace_state(max(leads)) if leads else None


def _window_pace(window: UsageWindow, now: int) -> PaceState | None:
    lead = pace_lead(window, now)
    if lead is None:
        return None
    state = pace_state(lead)
    if state != "high":
        return {"state": state, "runsOutAt": None}
    at = runs_out_at(window, now)
    # A limit already used up has no time ahead of it.
    return {"state": state, "runsOutAt": at if at is not None and at > now else None}


def with_pace(snapshot: ProviderSnapshot, instance: ProviderInstance, now: int) -> ProviderSnapshot:
    windows: list[UsageWindow] = [{**window, "pace": _window_pace(window, now)} for window in snapshot["windows"]]
    shown = [window for window in shown_limits(instance, windows) if window["pace"] is not None]
    level = account_pace(shown, now)
    runs_out = [pace["runsOutAt"] for window in shown if (pace := window["pace"]) and pace["runsOutAt"] is not None]
    account: PaceState | None = None
    if level is not None:
        account = {"state": level, "runsOutAt": min(runs_out) if level == "high" and runs_out else None}
    return {**snapshot, "windows": windows, "pace": account}
