"""Tells when one plan is signed into two apps, so adding it twice can be flagged."""

from typing import TypedDict

from tokengrill.core.json_util import record_at, string_at
from tokengrill.core.types import ProviderKind
from tokengrill.providers.opencode.entries import OpenCodeEntry


class AccountIdentity(TypedDict):
    kind: ProviderKind
    key: str


def identity_from_codex_auth(payload: dict[str, object]) -> AccountIdentity | None:
    tokens = record_at(payload, "tokens")
    key = string_at(tokens, "account_id") if tokens else None
    return {"kind": "codex", "key": key} if key else None


def identity_from_open_code(entry_id: str, entry: OpenCodeEntry) -> AccountIdentity | None:
    if entry_id == "openai" and entry["type"] == "oauth" and entry["accountId"]:
        return {"kind": "codex", "key": entry["accountId"]}
    return None


def duplicate_of(candidate: AccountIdentity | None, existing: dict[str, AccountIdentity | None]) -> str | None:
    """The id of an existing account on the same plan, or None when unknown."""
    if candidate is None:
        return None
    for account_id, identity in existing.items():
        if identity is not None and identity["kind"] == candidate["kind"] and identity["key"] == candidate["key"]:
            return account_id
    return None
