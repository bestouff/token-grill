"""The Codex access token, read from the CLI's own auth file."""

import time

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import record_at, string_at
from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.credentials import read_credential_json
from tokengrill.providers.jwt import jwt_expiry


async def load_codex_access_token(instance: ProviderInstance) -> str:
    """Never refreshed: the refresh token is single-use, so using it would sign the CLI out."""
    if instance["app"] == "opencode":
        # OpenCode sign-ins are read by the OpenCode provider support, which is not part of this module yet.
        raise ServiceError("auth-missing", "opencode.auth-missing")
    payload = await read_credential_json(provider_paths(instance)["authFile"])
    tokens = record_at(payload, "tokens")
    access_token = string_at(tokens, "access_token") if tokens else None
    if not access_token:
        raise ServiceError("auth-missing", "codex.auth-missing")
    expires_at = jwt_expiry(access_token)
    if expires_at is not None and expires_at <= time.time() * 1000:
        raise ServiceError("auth-expired", "codex.auth-expired")
    return access_token
