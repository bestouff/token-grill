from typing import Any

from tokengrill.core.types import ProviderInstance
from tokengrill.providers.candidates import open_code_candidates
from tokengrill.providers.identity import (
    AccountIdentity,
    duplicate_of,
    identity_from_codex_auth,
    identity_from_open_code,
)
from tokengrill.providers.opencode.entries import OpenCodeEntry


def oauth(account_id: str | None) -> OpenCodeEntry:
    return {"type": "oauth", "access": "a", "refresh": "r", "expires": None, "accountId": account_id}


def api_entry() -> OpenCodeEntry:
    return {"type": "api", "key": "k"}


def account(account_id: str, kind: str, app: str) -> ProviderInstance:
    instance: Any = {"id": account_id, "kind": kind, "app": app, "accountHome": "~/.x"}
    return instance


def codex_auth(account_id: str | None) -> dict[str, Any]:
    return {"auth_mode": "chatgpt", "tokens": {"access_token": "a", "refresh_token": "r", "account_id": account_id}}


# --- account-candidates.test.mjs


def test_open_code_sign_ins_join_their_own_service_with_duplicates_and_greyed_keys_marked() -> None:
    entries = {
        "openai": oauth("acct-1"),
        "anthropic": oauth(None),
        "kiro": oauth(None),
        "chutes": api_entry(),
        "deepseek": api_entry(),
    }
    configured = [account("work", "codex", "codex-cli"), account("main", "claude", "opencode")]
    identities: dict[str, AccountIdentity | None] = {"work": {"kind": "codex", "key": "acct-1"}, "main": None}
    found = open_code_candidates(entries, configured, identities, "/data/opencode")
    by_label = {item["label"]: item for item in found}
    assert [item["label"] for item in found] == ["Codex", "DeepSeek", "Claude", "Kiro", "chutes"]
    assert by_label["Codex"] == {
        "kind": "codex",
        "app": "opencode",
        "accountHome": "/data/opencode",
        "label": "Codex",
        "status": "ready",
        "duplicateOf": "work",
    }
    assert by_label["Claude"]["status"] == "already-added"
    assert by_label["DeepSeek"]["status"] == "ready"
    assert by_label["Kiro"]["status"] == "uses-other-app"
    assert by_label["chutes"] == {
        "kind": None,
        "app": "opencode",
        "accountHome": "/data/opencode",
        "label": "chutes",
        "status": "nothing-to-track",
        "duplicateOf": None,
    }


# --- account-identity.test.mjs


def test_the_same_chatgpt_account_in_codex_cli_and_open_code_is_a_duplicate() -> None:
    existing = {"work": identity_from_codex_auth(codex_auth("acct-1"))}
    assert duplicate_of(identity_from_open_code("openai", oauth("acct-1")), existing) == "work"


def test_different_account_ids_are_not_duplicates() -> None:
    existing = {"work": identity_from_codex_auth(codex_auth("acct-1"))}
    assert duplicate_of(identity_from_open_code("openai", oauth("acct-2")), existing) is None


def test_no_identity_never_warns() -> None:
    existing: dict[str, AccountIdentity | None] = {"work": None}
    assert identity_from_codex_auth({"tokens": {}}) is None
    assert identity_from_open_code("chutes", api_entry()) is None
    assert duplicate_of(None, existing) is None
