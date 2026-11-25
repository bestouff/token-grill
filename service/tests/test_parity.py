"""Every Python normalizer must give what the 0.4.1 TypeScript normalizer gave.

tests/parity/expected/*.json was written by tools/parity-dump.mjs from the v0.4.1 bundles
for the cases in tests/parity/inputs/*.json. Both sides see the same fixed "now": the
reset-credit cases carry it in "now" and pass it as fetched_at. Values are compared exactly
(floats included); only the Python-only "pace" keys are removed first. A normalizer that
raises is compared by its error code.
"""

import dataclasses
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.providers.antigravity.normalize import (
    antigravity_plan,
    extract_quota_summary_buckets,
    normalize_quota_summary,
)
from tokengrill.providers.claude.history import claude_usage_event
from tokengrill.providers.claude.normalize import normalize_claude_usage
from tokengrill.providers.codex.history import codex_usage_event
from tokengrill.providers.codex.normalize import normalize_codex_usage
from tokengrill.providers.codex.reset_credits import normalize_reset_credits
from tokengrill.providers.copilot.normalize import normalize_copilot_usage
from tokengrill.providers.cursor.normalize import is_jwt_like, normalize_cursor_plan, normalize_cursor_usage
from tokengrill.providers.deepseek.normalize import deepseek_key_from_claude_settings, normalize_deepseek_balance
from tokengrill.providers.kimi.normalize import kimi_api_host, normalize_kimi_usage
from tokengrill.providers.kiro.normalize import normalize_kiro_usage
from tokengrill.providers.opencode_go.normalize import normalize_open_code_go_usage

PARITY = Path(__file__).parent / "parity"

Case = dict[str, Any]

CALLS: dict[str, dict[str, Callable[[Case], object]]] = {
    "codex": {
        "usage": lambda c: normalize_codex_usage(c["payload"]),
        "reset_credits": lambda c: normalize_reset_credits(c["payload"], c["now"]),
        "usage_event": lambda c: codex_usage_event(c["payload"]),
    },
    "claude": {
        "usage": lambda c: normalize_claude_usage(c["payload"]),
        "usage_event": lambda c: claude_usage_event(c["payload"]),
    },
    "kiro": {"usage": lambda c: dataclasses.asdict(normalize_kiro_usage(c["payload"]))},
    "antigravity": {
        "plan": lambda c: antigravity_plan(c["payload"]),
        "buckets": lambda c: extract_quota_summary_buckets(c["payload"]),
        "usage": lambda c: normalize_quota_summary(c["payload"]),
    },
    "copilot": {"usage": lambda c: normalize_copilot_usage(c["payload"])},
    "opencode_go": {"usage": lambda c: normalize_open_code_go_usage(c["payload"])},
    "deepseek": {
        "balance": lambda c: normalize_deepseek_balance(c["payload"]),
        "claude_settings_key": lambda c: deepseek_key_from_claude_settings(c["payload"]),
    },
    "kimi": {
        "usage": lambda c: normalize_kimi_usage(c["payload"]),
        "api_host": lambda c: kimi_api_host(c["payload"]),
    },
    "cursor": {
        "usage": lambda c: normalize_cursor_usage(c["payload"]),
        "plan": lambda c: normalize_cursor_plan(c["payload"]),
        "is_jwt_like": lambda c: is_jwt_like(c["payload"]),
    },
}


def without_pace(value: object) -> object:
    if isinstance(value, dict):
        return {key: without_pace(item) for key, item in value.items() if key != "pace"}
    if isinstance(value, list):
        return [without_pace(item) for item in value]
    return value


def run(call: Callable[[Case], object], case: Case) -> dict[str, object]:
    try:
        return {"value": without_pace(call(case))}
    except ServiceError as error:
        return {"error": error.code}


def load_cases() -> list[tuple[str, Case, dict[str, object]]]:
    found: list[tuple[str, Case, dict[str, object]]] = []
    for path in sorted((PARITY / "inputs").glob("*.json")):
        cases: list[Case] = json.loads(path.read_text())
        expected: dict[str, dict[str, object]] = json.loads((PARITY / "expected" / path.name).read_text())
        assert [case["name"] for case in cases] == list(expected), path.name
        found.extend((path.stem, case, expected[case["name"]]) for case in cases)
    return found


CASES = load_cases()


def test_every_service_has_cases() -> None:
    assert {service for service, _, _ in CASES} == set(CALLS)


@pytest.mark.parametrize(("service", "case", "expected"), CASES, ids=[f"{s}-{c['name']}" for s, c, _ in CASES])
def test_normalizer_matches_0_4_1(service: str, case: Case, expected: dict[str, object]) -> None:
    assert run(CALLS[service][case["kind"]], case) == expected
