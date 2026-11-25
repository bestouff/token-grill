import math

from tokengrill.core.balance_meter import balance_window, next_balance_reference
from tokengrill.core.types import Balance
from tokengrill.storage.balances import BalanceReference

# --- balance-meter.test.mjs


def cny(amount: float) -> Balance:
    return {"amount": amount, "currency": "CNY"}


def step(reference: BalanceReference | None, amounts: list[float]) -> BalanceReference:
    current = reference
    for amount in amounts:
        current = next_balance_reference(current, cny(amount))
    assert current is not None
    return current


def test_the_first_reading_counts_as_full() -> None:
    reference = next_balance_reference(None, cny(80))
    assert reference == {"currency": "CNY", "full": 80, "last": 80}
    assert balance_window(cny(80), reference)["percent"] == 0


def test_spending_keeps_the_full_amount() -> None:
    reference = step(None, [100, 70, 42])
    assert reference == {"currency": "CNY", "full": 100, "last": 42}
    percent = balance_window(cny(42), reference)["percent"]
    assert percent is not None
    assert math.isclose(percent, 0.58)


def test_a_top_up_starts_a_new_full_amount_even_below_the_old_one() -> None:
    reference = step(None, [100, 10, 60])
    assert reference["full"] == 60
    assert balance_window(cny(60), reference)["percent"] == 0


def test_a_currency_change_starts_over() -> None:
    reference = next_balance_reference({"currency": "USD", "full": 50, "last": 20}, cny(30))
    assert reference == {"currency": "CNY", "full": 30, "last": 30}


def test_an_empty_account_reads_as_fully_used() -> None:
    reference = step(None, [0])
    assert balance_window(cny(0), reference)["percent"] == 1


def test_the_balance_limit_is_keyed_so_it_can_be_ticked_like_any_other_limit() -> None:
    window = balance_window(cny(42), {"currency": "CNY", "full": 100, "last": 42})
    assert (window["id"], window["canonicalWindow"], window["label"], window["resetAt"]) == (
        "balance",
        "other",
        "Balance",
        None,
    )
