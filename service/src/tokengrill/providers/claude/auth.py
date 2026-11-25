"""The Claude Code access token, read from the CLI's own credentials file."""

import time

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import record_at, string_at, to_epoch_ms
from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.credentials import read_credential_json


async def load_claude_access_token(instance: ProviderInstance) -> str:
    """Never refreshed: the refresh token is single-use, so using it would sign the CLI out."""
    if instance["app"] == "opencode":
        # OpenCode sign-ins are read by the OpenCode provider support, which is not part of this module yet.
        raise ServiceError("auth-missing", "opencode.auth-missing")
    payload = await read_credential_json(provider_paths(instance)["authFile"])
    oauth = record_at(payload, "claudeAiOauth")
    access_token = string_at(oauth, "accessToken") if oauth else None
    if not oauth or not access_token:
        raise ServiceError("auth-missing", "claude.auth-missing")
    expires_at = to_epoch_ms(oauth.get("expiresAt"))
    if expires_at is not None and expires_at <= time.time() * 1000:
        raise ServiceError("auth-expired", "claude.auth-expired")
    return access_token
