"""DeepSeek is prepaid: the documented GET /user/balance returns money left.

Shape: {is_available, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}]}.
"""

import re

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import is_record, record_at, string_at, to_number
from tokengrill.core.types import Balance

_CURRENCY = re.compile(r"[A-Z]{3}")
_HTTPS_HOST = re.compile(r"https://([^/:?#]+)", re.IGNORECASE)


def normalize_deepseek_balance(payload: object) -> Balance:
    infos = payload.get("balance_infos") if is_record(payload) else None
    for info in infos if isinstance(infos, list) else []:
        if not is_record(info):
            continue
        total = to_number(info.get("total_balance"))
        currency = string_at(info, "currency")
        # Intl.NumberFormat throws on anything that is not an ISO 4217 code.
        if total is not None and currency and _CURRENCY.fullmatch(currency):
            return {"amount": total, "currency": currency}
    raise ServiceError("response-shape", "net.no-usage")


def deepseek_key_from_claude_settings(settings: dict[str, object]) -> str | None:
    """Claude Code can be pointed at DeepSeek's Anthropic-compatible API; its key then
    sits in settings.json next to the DeepSeek base URL."""
    env = record_at(settings, "env")
    base_url = string_at(env, "ANTHROPIC_BASE_URL") if env else None
    token = string_at(env, "ANTHROPIC_AUTH_TOKEN") if env else None
    match = _HTTPS_HOST.match(base_url) if base_url else None
    host = match.group(1).lower() if match else ""
    return token if token and (host == "deepseek.com" or host.endswith(".deepseek.com")) else None
