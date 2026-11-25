"""The OpenCode Go key, read from OpenCode's auth file."""

from tokengrill.core.errors import ServiceError
from tokengrill.providers.opencode.auth_file import read_open_code_entries


async def load_open_code_go_key() -> str:
    """OpenCode stores the Go key as an API key, under its own id or the shared Zen one."""
    entries = await read_open_code_entries()
    entry = entries.get("opencode-go") or entries.get("opencode")
    if entry is None or entry["type"] != "api":
        raise ServiceError("auth-missing", "opencode-go.key-missing")
    return entry["key"]
