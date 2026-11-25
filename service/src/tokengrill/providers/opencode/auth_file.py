"""OpenCode's auth.json, read-only."""

from tokengrill.core.paths import open_code_auth_path
from tokengrill.providers.credentials import read_credential_json
from tokengrill.providers.opencode.entries import OpenCodeEntry, parse_open_code_auth


async def read_open_code_entries() -> dict[str, OpenCodeEntry]:
    return parse_open_code_auth(await read_credential_json(open_code_auth_path()))
