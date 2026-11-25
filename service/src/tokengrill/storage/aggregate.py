"""Daily token totals per account and model (history-v1.json), kept so history files are read once."""

import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypedDict

from tokengrill.core.json_util import is_record
from tokengrill.core.types import TokenTotals
from tokengrill.providers.pricing import PricingCatalog, cost_for
from tokengrill.storage.atomic_json import Persisted, data_path


class UsageEvent(TypedDict):
    capturedAt: int
    model: str | None
    totals: TokenTotals


class AggregateBucket(TypedDict):
    providerId: str
    date: str
    model: str
    totals: TokenTotals


def empty_totals() -> TokenTotals:
    return {"input": 0, "output": 0, "cachedInput": 0, "cacheWrite": 0, "reasoning": 0, "total": 0}


def add_totals(a: TokenTotals, b: TokenTotals) -> TokenTotals:
    return {
        "input": a["input"] + b["input"],
        "output": a["output"] + b["output"],
        "cachedInput": a["cachedInput"] + b["cachedInput"],
        "cacheWrite": a["cacheWrite"] + b["cacheWrite"],
        "reasoning": a["reasoning"] + b["reasoning"],
        "total": a["total"] + b["total"],
    }


def _bucket_key(provider_id: str, date: str, model: str) -> str:
    return json.dumps([provider_id, date, model])


def _bucket_start_ms(bucket: AggregateBucket) -> float:
    try:
        parsed = datetime.fromisoformat(f"{bucket['date']}T00:00:00+00:00")
    except ValueError:
        # Date.parse gives NaN, which no range includes.
        return math.nan
    return int(parsed.timestamp() * 1000)


def _day_of(captured_at_ms: int) -> str:
    return datetime.fromtimestamp(captured_at_ms / 1000, UTC).strftime("%Y-%m-%d")


def _is_bucket(value: object) -> bool:
    return (
        is_record(value)
        and isinstance(value.get("providerId"), str)
        and isinstance(value.get("date"), str)
        and isinstance(value.get("model"), str)
        and is_record(value.get("totals"))
    )


class AggregateStore(Persisted):
    def __init__(self, path: Path | None = None) -> None:
        super().__init__(path or data_path("history-v1.json"))
        self._buckets: dict[str, AggregateBucket] = {}

    async def load(self) -> None:
        file = await self._read()
        buckets: Any = file.get("buckets")
        # The file is ours, but a damaged one must not stop the service from starting.
        for item in buckets if isinstance(buckets, list) else []:
            if not _is_bucket(item):
                continue
            bucket: AggregateBucket = {
                "providerId": item["providerId"],
                "date": item["date"],
                "model": item["model"],
                "totals": item["totals"],
            }
            self._buckets[_bucket_key(bucket["providerId"], bucket["date"], bucket["model"])] = bucket

    def add(self, provider_id: str, event: UsageEvent) -> None:
        date = _day_of(event["capturedAt"])
        model = event["model"] if event["model"] is not None else "unknown"
        key = _bucket_key(provider_id, date, model)
        existing = self._buckets.get(key)
        base = existing["totals"] if existing else empty_totals()
        self._buckets[key] = {
            "providerId": provider_id,
            "date": date,
            "model": model,
            "totals": add_totals(base, event["totals"]),
        }
        self._mark_dirty()

    def buckets_since(self, provider_id: str, since_ms: float) -> list[AggregateBucket]:
        return [
            bucket
            for bucket in self._buckets.values()
            if bucket["providerId"] == provider_id and _bucket_start_ms(bucket) >= since_ms
        ]

    def totals(self, provider_id: str, since_ms: float) -> TokenTotals:
        total = empty_totals()
        for bucket in self.buckets_since(provider_id, since_ms):
            total = add_totals(total, bucket["totals"])
        return total

    def cost(self, provider_id: str, since_ms: float, catalog: PricingCatalog) -> float | None:
        """None when no model in the range has a known price."""
        total: float | None = None
        for bucket in self.buckets_since(provider_id, since_ms):
            rate = catalog.get(bucket["model"])
            if rate is not None:
                total = (total or 0) + cost_for(bucket["totals"], rate)
        return total

    async def remove_provider(self, provider_id: str) -> None:
        for key in [key for key, bucket in self._buckets.items() if bucket["providerId"] == provider_id]:
            del self._buckets[key]
        self._mark_dirty()
        await self.flush()

    def _contents(self) -> object:
        return {"schemaVersion": 1, "buckets": list(self._buckets.values())}
