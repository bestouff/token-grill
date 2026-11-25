"""A prepaid balance as a meter.

The service reports only what is left, so the amount after the most recent top-up counts as full:
any rise in the balance is a top-up, and spending never moves the full amount.
"""

from tokengrill.core.json_util import clamp_fraction
from tokengrill.core.types import BALANCE_KEY, Balance, UsageWindow
from tokengrill.storage.balances import BalanceReference


def next_balance_reference(previous: BalanceReference | None, balance: Balance) -> BalanceReference:
    start_over = previous is None or previous["currency"] != balance["currency"] or balance["amount"] > previous["last"]
    full = balance["amount"] if previous is None or start_over else previous["full"]
    return {"currency": balance["currency"], "full": full, "last": balance["amount"]}


def balance_window(balance: Balance, reference: BalanceReference) -> UsageWindow:
    used = 1 - balance["amount"] / reference["full"] if reference["full"] > 0 else 1
    return {
        "id": BALANCE_KEY,
        "canonicalWindow": "other",
        "label": "Balance",
        "used": None,
        "limit": None,
        "percent": clamp_fraction(used),
        "resetAt": None,
        "durationSeconds": None,
        "unit": None,
        "pace": None,
    }
