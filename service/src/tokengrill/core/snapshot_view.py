"""The snapshot as the bus sends it, with what the extension shows already worked out."""

from tokengrill.core.history_metrics import history_metrics
from tokengrill.core.pace import with_pace
from tokengrill.core.paths import home_is_default
from tokengrill.core.topbar import limit_key, ordered_limits, shown_limits
from tokengrill.core.types import (
    ProviderInstance,
    ProviderRuntimeState,
    ProviderSnapshot,
    SnapshotView,
    UsageWindow,
    WindowView,
)


def _keyed(window: UsageWindow) -> WindowView:
    return {**window, "key": limit_key(window)}


def snapshot_view(
    snapshot: ProviderSnapshot, instance: ProviderInstance, runtime: ProviderRuntimeState | None, now: int
) -> SnapshotView:
    paced = with_pace(snapshot, instance, now)
    windows: list[UsageWindow] = [_keyed(window) for window in ordered_limits(paced["windows"])]
    return {
        **paced,
        "windows": windows,
        "shownLimits": [limit_key(window) for window in shown_limits(instance, paced["windows"])],
        "history": history_metrics(instance, snapshot, runtime),
        "homeIsDefault": home_is_default(instance),
    }
