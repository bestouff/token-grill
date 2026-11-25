from tokengrill.core.types import TokenTotals
from tokengrill.providers.pricing import PricingCatalog, cost_for, load_catalog
from tokengrill.storage.aggregate import AggregateStore, UsageEvent

TOTALS: TokenTotals = {
    "input": 1_000_000,
    "output": 500_000,
    "cachedInput": 2_000_000,
    "cacheWrite": 0,
    "reasoning": 0,
    "total": 1_500_000,
}


def test_costs_are_computed_per_million_tokens() -> None:
    assert cost_for(TOTALS, {"input": 1, "output": 4, "cachedInput": 0.1, "cacheWrite": 2}) == 1 + 2 + 0.2


def test_cache_rates_fall_back_to_the_input_rate() -> None:
    assert cost_for(TOTALS, {"input": 1, "output": 4}) == 1 + 2 + 2


def test_the_shipped_catalog_loads() -> None:
    catalog = load_catalog()
    assert len(catalog) > 0
    assert all("input" in rate and "output" in rate for rate in catalog.values())


def _event(day: str, model: str | None, tokens: int) -> UsageEvent:
    from datetime import UTC, datetime

    captured = int(datetime.fromisoformat(f"{day}T12:00:00+00:00").astimezone(UTC).timestamp() * 1000)
    totals: TokenTotals = {
        "input": tokens,
        "output": 0,
        "cachedInput": 0,
        "cacheWrite": 0,
        "reasoning": 0,
        "total": tokens,
    }
    return {"capturedAt": captured, "model": model, "totals": totals}


def test_aggregate_cost_sums_priced_models_and_is_none_without_prices() -> None:
    store = AggregateStore()
    store.add("a", _event("2026-08-07", "m1", 1_000_000))
    store.add("a", _event("2026-08-08", "m1", 1_000_000))
    store.add("a", _event("2026-08-08", "unpriced", 5_000_000))
    store.add("b", _event("2026-08-08", "m1", 9_000_000))
    catalog: PricingCatalog = {"m1": {"input": 2.0, "output": 1.0}}
    assert store.cost("a", 0, catalog) == 4.0
    since = 1786147200000  # 2026-08-08T00:00:00Z
    assert store.cost("a", since, catalog) == 2.0
    assert store.cost("a", 0, {}) is None
    assert store.cost("none", 0, catalog) is None
