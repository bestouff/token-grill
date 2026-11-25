"""The Codex session log line that carries the usage of one model turn."""

from tokengrill.core.json_util import number_at, parse_record, record_at, string_at, to_epoch_ms
from tokengrill.core.types import UsageEvent


def codex_usage_event(line: str) -> UsageEvent | None:
    """Codex records each turn in a `token_count` event. It names no model, so these totals are not priced."""
    # Most lines are messages and tool calls, so they are skipped before the costlier JSON parse.
    if '"token_count"' not in line:
        return None
    record = parse_record(line)
    payload = record_at(record, "payload") if record else None
    if not record or record.get("type") != "event_msg" or not payload or payload.get("type") != "token_count":
        return None
    info = record_at(payload, "info")
    usage = record_at(info, "last_token_usage") if info else None
    captured_at = to_epoch_ms(string_at(record, "timestamp"))
    if not usage or captured_at is None:
        return None
    input_tokens = number_at(usage, "input_tokens") or 0
    output_tokens = number_at(usage, "output_tokens") or 0
    total = number_at(usage, "total_tokens")
    if total is None:
        total = input_tokens + output_tokens
    if not total:
        return None
    return {
        "capturedAt": int(captured_at),
        "model": None,
        "totals": {
            "input": int(input_tokens),
            "output": int(output_tokens),
            "cachedInput": int(number_at(usage, "cached_input_tokens") or 0),
            "cacheWrite": 0,
            "reasoning": int(number_at(usage, "reasoning_output_tokens") or 0),
            "total": int(total),
        },
    }
