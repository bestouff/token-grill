"""The Claude Code session log line that carries the usage of one assistant message."""

from tokengrill.core.json_util import number_at, parse_record, record_at, string_at, to_epoch_ms
from tokengrill.core.types import UsageEvent


def claude_usage_event(line: str) -> UsageEvent | None:
    """Claude Code writes one JSON record per line; only assistant messages carry usage."""
    # Most lines carry no usage, so they are skipped before the costlier JSON parse.
    if '"usage"' not in line:
        return None
    record = parse_record(line)
    if not record:
        return None
    message = record_at(record, "message")
    usage = record_at(message, "usage") if message else None
    captured_at = to_epoch_ms(string_at(record, "timestamp"))
    if not message or not usage or captured_at is None:
        return None
    input_tokens = number_at(usage, "input_tokens") or 0
    output_tokens = number_at(usage, "output_tokens") or 0
    total = input_tokens + output_tokens
    if not total:
        return None
    return {
        "capturedAt": int(captured_at),
        "model": string_at(message, "model"),
        "totals": {
            "input": int(input_tokens),
            "output": int(output_tokens),
            "cachedInput": int(number_at(usage, "cache_read_input_tokens") or 0),
            "cacheWrite": int(number_at(usage, "cache_creation_input_tokens") or 0),
            "reasoning": 0,
            "total": int(total),
        },
    }
