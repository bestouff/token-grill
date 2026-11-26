"""The Claude Code access token, read from the CLI's own credentials file."""

import time

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import record_at, string_at, to_epoch_ms
from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.credentials import read_credential_json
from tokengrill.providers.opencode.auth_file import read_open_code_entries
from tokengrill.providers.opencode.entries import open_code_access_token


async def load_claude_access_token(instance: ProviderInstance) -> str:
    """Read-only, including when preferences inspect an expired sign-in."""
    if instance["app"] == "opencode":
        return open_code_access_token((await read_open_code_entries()).get("anthropic"), time.time() * 1000)
    payload = await read_credential_json(provider_paths(instance)["authFile"])
    oauth = record_at(payload, "claudeAiOauth")
    access_token = string_at(oauth, "accessToken") if oauth else None
    if not oauth or not access_token:
        raise ServiceError("auth-missing", "claude.auth-missing")
    expires_at = to_epoch_ms(oauth.get("expiresAt"))
    if expires_at is not None and expires_at <= time.time() * 1000:
        raise ServiceError("auth-expired", "claude.auth-expired")
    return access_token
