"""The agy CLI's token envelope."""

from typing import TypedDict

from tokengrill.core.json_util import parse_record, record_at, string_at, to_epoch_ms

# The agy CLI stores its OAuth token through go-keyring, which on Linux is a
# generic Secret Service item with these attributes.
AGY_KEYRING_SCHEMA = "org.freedesktop.Secret.Generic"
AGY_KEYRING_ATTRIBUTES = {"service": "gemini", "username": "antigravity"}


class AgyKeyringToken(TypedDict):
    accessToken: str
    refreshToken: str | None
    expiresAt: int | float | None


def parse_agy_keyring_payload(raw: str) -> AgyKeyringToken | None:
    """The item holds Go's serialized oauth2.Token; `expiry` is RFC 3339 with nanoseconds."""
    payload = parse_record(raw)
    token = record_at(payload, "token") if payload else None
    access_token = string_at(token, "access_token") if token else None
    if not token or not access_token:
        return None
    expiry = string_at(token, "expiry")
    return {
        "accessToken": access_token,
        "refreshToken": string_at(token, "refresh_token"),
        "expiresAt": to_epoch_ms(expiry) if expiry else None,
    }
