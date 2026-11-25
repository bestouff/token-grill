"""The top-bar selection decisions of an account; the Shell only draws the result."""

from tokengrill.core.types import CanonicalQuotaWindow, ProviderInstance, TopBarSelection, UsageWindow

_WINDOW_RANK: dict[CanonicalQuotaWindow, int] = {"five-hour": 0, "weekly": 1, "monthly": 2, "other": 3}


def limit_key(window: UsageWindow) -> str:
    return window["id"] if window["canonicalWindow"] == "other" else window["canonicalWindow"]


def ordered_limits(windows: list[UsageWindow]) -> list[UsageWindow]:
    """The popup's order: five-hour, weekly, monthly, then other limits as the service lists them."""
    return sorted(windows, key=lambda window: _WINDOW_RANK[window["canonicalWindow"]])


def most_used_window(windows: list[UsageWindow]) -> UsageWindow | None:
    highest: UsageWindow | None = None
    highest_percent = -1.0
    for window in windows:
        percent = window["percent"] if window["percent"] is not None else -1.0
        if percent > highest_percent:
            highest, highest_percent = window, percent
    return highest


def is_shown(instance: ProviderInstance, window: str | None = None) -> bool:
    """Whether the account is in the top bar, or, given a limit key, whether that limit is ticked."""
    selection = instance["topBar"]
    if window is not None:
        return not selection["automatic"] and window in selection["limits"]
    return selection["automatic"] or len(selection["limits"]) > 0


def shown_limits(instance: ProviderInstance, windows: list[UsageWindow]) -> list[UsageWindow]:
    selection = instance["topBar"]
    if selection["automatic"]:
        pressing = most_used_window(windows)
        return [pressing] if pressing else []
    return [window for window in ordered_limits(windows) if limit_key(window) in selection["limits"]]


def _in_popup_order(keys: list[str], windows: list[UsageWindow]) -> list[str]:
    order = [limit_key(window) for window in ordered_limits(windows)]
    known = [key for key in order if key in keys]
    return [*known, *(key for key in keys if key not in order)]


def _with_selection(instance: ProviderInstance, selection: TopBarSelection) -> ProviderInstance:
    return {**instance, "topBar": selection}


def toggle_limit(instance: ProviderInstance, key: str, windows: list[UsageWindow] | None = None) -> ProviderInstance:
    """The first click while automatic keeps what was showing, so nothing vanishes;
    clicking the limit automatic had chosen just pins it."""
    known = windows or []
    selection = instance["topBar"]
    if selection["automatic"]:
        shown = shown_limits(instance, known)
        kept = limit_key(shown[0]) if shown else key
        return _with_selection(
            instance, {"automatic": False, "limits": _in_popup_order(list(dict.fromkeys([kept, key])), known)}
        )
    current = selection["limits"]
    limits = [item for item in current if item != key] if key in current else [*current, key]
    return _with_selection(instance, {"automatic": False, "limits": _in_popup_order(limits, known)})


def set_automatic(instance: ProviderInstance, on: bool) -> ProviderInstance:
    if on:
        return _with_selection(instance, {"automatic": True, "limits": []})
    return _with_selection(instance, {"automatic": False, "limits": list(instance["topBar"]["limits"])})
