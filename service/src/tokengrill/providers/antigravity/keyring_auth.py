"""The agy CLI sign-in, read from the Secret Service without unlocking it."""

from tokengrill.core.errors import ServiceError
from tokengrill.providers.antigravity.keyring_payload import (
    AGY_KEYRING_ATTRIBUTES,
    AGY_KEYRING_SCHEMA,
    AgyKeyringToken,
    parse_agy_keyring_payload,
)
from tokengrill.providers.keyring import lookup_secret

KEYRING_UNAVAILABLE = "antigravity.keyring-unavailable"


async def lookup_agy_keyring_token() -> AgyKeyringToken | None:
    raw = await lookup_secret(AGY_KEYRING_SCHEMA, AGY_KEYRING_ATTRIBUTES, KEYRING_UNAVAILABLE)
    if not raw:
        return None
    token = parse_agy_keyring_payload(raw)
    if token is None:
        raise ServiceError("auth-invalid", "antigravity.keyring-unreadable")
    return token
