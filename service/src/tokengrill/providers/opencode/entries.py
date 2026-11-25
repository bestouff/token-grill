"""OpenCode keeps every sign-in in one auth.json, keyed by its provider id.

Field names are the ones OpenCode writes: type, access, refresh, expires, accountId, key.
"""

from typing import Any, Literal, NotRequired, TypedDict

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import is_record, number_at, string_at
from tokengrill.core.types import ProviderKind


class OpenCodeOauthEntry(TypedDict):
    type: Literal["oauth"]
    access: str
    refresh: str | None
    expires: int | float | None
    accountId: str | None


class OpenCodeApiEntry(TypedDict):
    type: Literal["api"]
    key: str


OpenCodeEntry = OpenCodeOauthEntry | OpenCodeApiEntry


class OpenCodeMatch(TypedDict):
    status: Literal["service", "uses-other-app", "nothing-to-track"]
    kind: NotRequired[ProviderKind]


# OpenCode provider ids whose sign-in reaches a service Token Grill tracks.
OPENCODE_SERVICES: dict[str, tuple[ProviderKind, Literal["oauth", "api"]]] = {
    "openai": ("codex", "oauth"),
    "anthropic": ("claude", "oauth"),
    "github-copilot": ("copilot", "oauth"),
    "opencode-go": ("opencode-go", "api"),
    "opencode": ("opencode-go", "api"),
    "deepseek": ("deepseek", "api"),
    "kimi-for-coding": ("kimi", "api"),
}

# OpenCode's Kiro plugin uses kiro-cli's own sign-in, so the account is added from the Kiro app.
SHARED_SIGN_INS: dict[str, ProviderKind] = {"kiro": "kiro"}


def _parse_entry(value: object) -> OpenCodeEntry | None:
    if not is_record(value):
        return None
    kind = string_at(value, "type")
    if kind == "api":
        key = string_at(value, "key")
        return {"type": "api", "key": key} if key else None
    if kind != "oauth":
        return None
    access = string_at(value, "access")
    if not access:
        return None
    return {
        "type": "oauth",
        "access": access,
        "refresh": string_at(value, "refresh"),
        "expires": number_at(value, "expires"),
        "accountId": string_at(value, "accountId"),
    }


def parse_open_code_auth(payload: dict[str, Any]) -> dict[str, OpenCodeEntry]:
    entries: dict[str, OpenCodeEntry] = {}
    for entry_id, value in payload.items():
        entry = _parse_entry(value)
        if entry:
            entries[entry_id] = entry
    return entries


def open_code_access_token(entry: OpenCodeEntry | None, now: float) -> str:
    """OpenCode refreshes its own sign-ins; Token Grill only reads them."""
    if entry is None:
        raise ServiceError("auth-missing", "opencode.auth-missing")
    if entry["type"] != "oauth":
        raise ServiceError("auth-invalid", "opencode.api-key-only")
    expires = entry["expires"]
    if expires is not None and expires <= now:
        raise ServiceError("auth-expired", "opencode.auth-expired")
    return entry["access"]


def open_code_github_token(entry: OpenCodeEntry | None) -> str:
    """OpenCode's Copilot sign-in keeps the GitHub token as its refresh token; the access token is a
    short-lived Copilot session token that the usage API refuses."""
    if entry is None or entry["type"] != "oauth" or not entry["refresh"]:
        raise ServiceError("auth-missing", "opencode.copilot-missing")
    return entry["refresh"]


def match_open_code_entry(entry_id: str, entry: OpenCodeEntry) -> OpenCodeMatch:
    shared = SHARED_SIGN_INS.get(entry_id)
    if shared:
        return {"status": "uses-other-app", "kind": shared}
    service = OPENCODE_SERVICES.get(entry_id)
    if service and service[1] == entry["type"]:
        return {"status": "service", "kind": service[0]}
    return {"status": "nothing-to-track"}
