"""What the service keeps of a reading beyond the file format: restoring it and telling when it changed.

stored_reading and parse_stored_reading live with the file they describe in storage/readings.py.
"""

import json
from typing import cast

from tokengrill.core.types import ProviderSnapshot, UsageWindow, empty_snapshot
from tokengrill.storage.readings import StoredReading


def restored_snapshot(provider_id: str, reading: StoredReading) -> ProviderSnapshot:
    """The reading is shown as it was, with its age; the next refresh replaces it."""
    credits = reading["resetCredits"]
    return {
        **empty_snapshot(provider_id),
        "state": "stale",
        "plan": reading["plan"],
        "windows": [cast(UsageWindow, {**window, "pace": None}) for window in reading["windows"]],
        "balance": reading["balance"],
        # mypy types a TypedDict spread with a new key as a plain dict.
        "resetCredits": {**credits, "stale": True} if credits else None,  # type: ignore[typeddict-item]
        "lastUpdated": reading["fetchedAt"],
        "quotaFetchedAt": reading["fetchedAt"],
    }


def snapshot_fingerprint(snapshot: ProviderSnapshot | None) -> str:
    """A small stable representation of the data users care about.

    Fetch times, errors and refresh state are left out, so a successful check with
    identical values counts as no change.
    """
    if snapshot is None:
        return ""
    credits = snapshot["resetCredits"]
    return json.dumps(
        {
            "plan": snapshot["plan"],
            "account": snapshot["account"],
            "windows": snapshot["windows"],
            "resetCredits": {"availableCount": credits["availableCount"], "credits": credits["credits"]}
            if credits
            else None,
            "totals": snapshot["totals"],
            "todayTotals": snapshot["todayTotals"],
            "monthTotals": snapshot["monthTotals"],
            "todayCost": snapshot["todayCost"],
            "monthCost": snapshot["monthCost"],
        },
        sort_keys=True,
    )
