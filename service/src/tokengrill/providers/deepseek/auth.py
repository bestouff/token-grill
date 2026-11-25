"""The API key of a DeepSeek account, read from where it was added; never stored."""

from tokengrill.core.errors import ServiceError
from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.credentials import read_credential_json
from tokengrill.providers.deepseek.normalize import deepseek_key_from_claude_settings
from tokengrill.providers.keyring import KEY_UNAVAILABLE, TOKEN_GRILL_KEY_SCHEMA, lookup_secret
from tokengrill.providers.opencode.auth_file import read_open_code_entries


async def load_deepseek_key(instance: ProviderInstance) -> str:
    """Token Grill's own keyring entry, OpenCode, or Claude Code settings that point at DeepSeek."""
    key: str | None
    if instance["app"] == "keyring":
        key = await lookup_secret(TOKEN_GRILL_KEY_SCHEMA, {"account": instance["id"]}, KEY_UNAVAILABLE)
    elif instance["app"] == "opencode":
        entry = (await read_open_code_entries()).get("deepseek")
        key = entry["key"] if entry is not None and entry["type"] == "api" else None
    else:
        key = deepseek_key_from_claude_settings(await read_credential_json(provider_paths(instance)["authFile"]))
    if not key:
        raise ServiceError("auth-missing", "deepseek.key-missing")
    return key
