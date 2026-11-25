"""Per-million-token rates and the catalog that ships with the service."""

import json
from importlib import resources
from typing import NotRequired, TypedDict

from tokengrill.core.json_util import is_record
from tokengrill.core.types import TokenTotals


class ModelRate(TypedDict):
    input: float
    output: float
    cachedInput: NotRequired[float | None]
    cacheWrite: NotRequired[float | None]


PricingCatalog = dict[str, ModelRate]


def cost_for(totals: TokenTotals, rate: ModelRate) -> float:
    """Rates are per million tokens; cache rates default to the input rate."""
    cached_rate = rate.get("cachedInput")
    write_rate = rate.get("cacheWrite")
    input_cost = totals["input"] * rate["input"]
    output_cost = totals["output"] * rate["output"]
    cached_cost = totals["cachedInput"] * (cached_rate if cached_rate is not None else rate["input"])
    write_cost = totals["cacheWrite"] * (write_rate if write_rate is not None else rate["input"])
    return (input_cost + output_cost + cached_cost + write_cost) / 1_000_000


def load_catalog() -> PricingCatalog:
    """The catalog is part of the package, so a missing file is a broken install and raises."""
    text = resources.files("tokengrill").joinpath("data", "pricing-v1.json").read_text(encoding="utf-8")
    payload: object = json.loads(text)
    if is_record(payload) and is_record(payload.get("models")):
        return dict(payload["models"])
    return {}
