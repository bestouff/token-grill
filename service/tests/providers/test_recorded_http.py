import json
from pathlib import Path

import httpx

from tokengrill.net.http import HttpClient
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.pricing import PricingCatalog
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.checkpoints import CheckpointStore


def context(tmp_path: Path, records: list[tuple[str, str]], status: int = 200) -> CollectorContext:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"access_token": "sk-abc123secretvalue", "rows": [1, 2]})

    pricing: PricingCatalog = {}
    return CollectorContext(
        http=HttpClient(httpx.MockTransport(handle)),
        pricing=pricing,
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        on_record=lambda step, detail: records.append((step, detail)),
    )


async def test_a_request_through_the_context_records_the_request_and_the_response_shape(tmp_path: Path) -> None:
    records: list[tuple[str, str]] = []
    ctx = context(tmp_path, records)
    body = await ctx.http.request_json(
        "GET", "https://api.deepseek.com/user/balance?key=sk-abc123", {"Authorization": "Bearer sk-abc123secretvalue"}
    )
    assert body == {"access_token": "sk-abc123secretvalue", "rows": [1, 2]}
    assert records == [
        ("request", "GET api.deepseek.com/user/balance"),
        ("response", "{access_token: string, rows: [2 items]}"),
    ]
    assert "sk-abc" not in json.dumps(records)


async def test_a_failed_request_records_only_the_request(tmp_path: Path) -> None:
    records: list[tuple[str, str]] = []
    ctx = context(tmp_path, records, status=500)
    try:
        await ctx.http.request_json("POST", "https://api.deepseek.com/x", {}, {"a": 1})
    except Exception as error:  # noqa: BLE001 - the type is not the point of this test
        assert type(error).__name__ == "ServiceError"
    else:
        raise AssertionError("expected an error")
    assert records == [("request", "POST api.deepseek.com/x")]
