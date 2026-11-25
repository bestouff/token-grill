"""The Kimi Code token and region host of an account; the Kimi CLI refreshes its own sign-in."""

import time
from pathlib import Path
from typing import TypedDict

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import string_at, to_epoch_ms
from tokengrill.core.paths import expand_path, provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.credentials import read_credential_json, read_credential_text
from tokengrill.providers.kimi.normalize import kimi_api_host
from tokengrill.providers.opencode.auth_file import read_open_code_entries


class KimiAuth(TypedDict):
    token: str
    host: str


async def _configured_host(instance: ProviderInstance) -> str:
    """The region host is optional configuration; without it Kimi Code uses the global host."""
    try:
        return kimi_api_host(
            await read_credential_text(str(Path(expand_path(instance["accountHome"])) / "config.toml"))
        )
    except ServiceError:
        return kimi_api_host("")


async def load_kimi_auth(instance: ProviderInstance) -> KimiAuth:
    if instance["app"] == "opencode":
        entry = (await read_open_code_entries()).get("kimi-for-coding")
        if entry is None or entry["type"] != "api":
            raise ServiceError("auth-missing", "kimi.opencode-key-missing")
        return {"token": entry["key"], "host": kimi_api_host("")}
    payload = await read_credential_json(provider_paths(instance)["authFile"])
    token = string_at(payload, "access_token")
    if not token:
        raise ServiceError("auth-missing", "kimi.auth-missing")
    expires_at = to_epoch_ms(payload.get("expires_at"))
    if expires_at is not None and expires_at <= time.time() * 1000:
        raise ServiceError("auth-expired", "kimi.auth-expired")
    return {"token": token, "host": await _configured_host(instance)}
