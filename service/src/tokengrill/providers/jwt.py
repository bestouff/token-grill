"""Claims of a JWT access token, read without verifying it."""

import base64
import binascii

from tokengrill.core.json_util import parse_record, string_at, to_epoch_ms


def _claims(token: str) -> dict[str, object] | None:
    parts = token.split(".")
    claims = parts[1] if len(parts) > 1 else ""
    if not claims:
        return None
    padded = claims.replace("-", "+").replace("_", "/").ljust(-(-len(claims) // 4) * 4, "=")
    try:
        text = base64.b64decode(padded).decode("utf-8", errors="replace")
    except (binascii.Error, ValueError):
        return None
    return parse_record(text)


def jwt_expiry(token: str) -> int | float | None:
    """The `exp` claim tells whether a request is worth sending."""
    payload = _claims(token)
    return to_epoch_ms(payload.get("exp")) if payload else None


def jwt_subject(token: str) -> str | None:
    """The `sub` claim names the account the token belongs to."""
    payload = _claims(token)
    return string_at(payload, "sub") if payload else None
