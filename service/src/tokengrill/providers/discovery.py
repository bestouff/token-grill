"""Finds the accounts that can be added from each app; read-only, no network, no keyring unlock.

The folder scans are blocking, so they run in a worker thread.
"""

import asyncio
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, get_args

from tokengrill.core.config import new_provider, provider_label
from tokengrill.core.errors import ServiceError
from tokengrill.core.paths import (
    auth_file_candidates,
    cursor_agent_home,
    default_home,
    expand_path,
    open_code_auth_path,
    path_exists,
    provider_paths,
)
from tokengrill.core.types import AccountApp, ProviderInstance, ProviderKind
from tokengrill.providers.candidates import Candidate, by_status, open_code_candidates
from tokengrill.providers.copilot.auth import copilot_cli_token
from tokengrill.providers.credentials import read_credential_json
from tokengrill.providers.deepseek.normalize import deepseek_key_from_claude_settings
from tokengrill.providers.identity import (
    AccountIdentity,
    duplicate_of,
    identity_from_codex_auth,
    identity_from_open_code,
)
from tokengrill.providers.opencode.auth_file import read_open_code_entries
from tokengrill.providers.opencode.entries import OpenCodeEntry

ALL_APPS: tuple[AccountApp, ...] = get_args(AccountApp)


def _has_credentials(provider: ProviderInstance) -> bool:
    return any(path_exists(path) for path in auth_file_candidates(provider))


def _prefixed_directories(prefix: str) -> list[str]:
    """Folders of the user's home whose names start with the prefix, such as ~/.codex-work."""
    with os.scandir(Path.home()) as entries:
        return sorted(entry.name for entry in entries if entry.name.startswith(prefix) and entry.is_dir())


def home_name(kind: ProviderKind, folder: str) -> str:
    """A second Codex or Claude account lives in its own home such as ~/.codex-work, so the suffix is
    the only name it has. Other folders keep the service name."""
    label = provider_label(kind)
    prefix = f".{kind}"
    return f"{label}{folder[len(prefix) :]}" if folder.startswith(prefix) and folder != prefix else label


def cli_homes(kind: Literal["codex", "claude"]) -> list[ProviderInstance]:
    app: AccountApp = "codex-cli" if kind == "codex" else "claude-code"
    providers: list[ProviderInstance] = []
    for name in _prefixed_directories(f".{kind}"):
        provider = new_provider(kind, app, f"~/{name}")
        if not _has_credentials(provider) and not any(
            path_exists(path) for path in provider_paths(provider)["historyDirectories"]
        ):
            continue
        provider["displayName"] = home_name(kind, name)
        providers.append(provider)
    return providers


def antigravity_homes() -> list[ProviderInstance]:
    home = str(Path.home())
    # The agy CLI keeps its token in the keyring, so its home is recognised by its own state files.
    cli_home = f"{home}/.gemini/antigravity-cli"
    providers: list[ProviderInstance] = []
    if any(path_exists(f"{cli_home}/{name}") for name in ("settings.json", "installation_id")):
        providers.append(new_provider("antigravity", "antigravity", cli_home))
    for path in (f"{home}/.gemini/antigravity", f"{home}/.antigravity", f"{home}/.config/Antigravity"):
        provider = new_provider("antigravity", "antigravity", path)
        if _has_credentials(provider):
            providers.append(provider)
    return providers


def _single(kind: ProviderKind, app: AccountApp, home: str) -> list[ProviderInstance]:
    provider = new_provider(kind, app, home)
    return [provider] if _has_credentials(provider) else []


def kiro_homes() -> list[ProviderInstance]:
    return _single("kiro", "kiro-cli", default_home("kiro"))


def kimi_homes() -> list[ProviderInstance]:
    return _single("kimi", "kimi-cli", default_home("kimi"))


def cursor_homes() -> list[ProviderInstance]:
    return _single("cursor", "cursor", default_home("cursor"))


def cursor_agent_homes() -> list[ProviderInstance]:
    return _single("cursor", "cursor-agent", cursor_agent_home())


def github_cli_homes() -> list[ProviderInstance]:
    return _single("copilot", "github-cli", default_home("copilot"))


async def _read_or_none(path: str) -> dict[str, object] | None:
    """A sign-in that cannot be read is simply not offered."""
    try:
        return await read_credential_json(path)
    except ServiceError:
        return None


def _same_home(first: str, second: str) -> bool:
    return bool(first and second) and expand_path(first) == expand_path(second)


async def _open_code_entries() -> dict[str, OpenCodeEntry]:
    try:
        return await read_open_code_entries()
    except ServiceError:
        return {}


async def _codex_identity(provider: ProviderInstance) -> AccountIdentity | None:
    payload = await _read_or_none(provider_paths(provider)["authFile"])
    return identity_from_codex_auth(payload) if payload else None


async def _configured_identities(
    configured: list[ProviderInstance], entries: dict[str, OpenCodeEntry]
) -> dict[str, AccountIdentity | None]:
    """Only a Codex sign-in carries an account identity, so only Codex accounts can be matched
    against a sign-in found elsewhere."""
    open_ai = entries.get("openai")
    from_open_code = identity_from_open_code("openai", open_ai) if open_ai else None
    codex = [provider for provider in configured if provider["kind"] == "codex"]

    async def identity(provider: ProviderInstance) -> AccountIdentity | None:
        return from_open_code if provider["app"] == "opencode" else await _codex_identity(provider)

    return dict(zip([provider["id"] for provider in codex], await asyncio.gather(*map(identity, codex)), strict=True))


@dataclass(frozen=True)
class _Search:
    configured: list[ProviderInstance]
    identities: dict[str, AccountIdentity | None]
    entries: dict[str, OpenCodeEntry]


async def _home_candidates(found: list[ProviderInstance], search: _Search) -> list[Candidate]:
    async def candidate(provider: ProviderInstance) -> Candidate:
        added = any(
            item["app"] == provider["app"] and _same_home(item["accountHome"], provider["accountHome"])
            for item in search.configured
        )
        identity = await _codex_identity(provider) if not added and provider["kind"] == "codex" else None
        return {
            "kind": provider["kind"],
            "app": provider["app"],
            "accountHome": provider["accountHome"],
            "label": provider["displayName"],
            "status": "already-added" if added else "ready",
            "duplicateOf": duplicate_of(identity, search.identities),
        }

    return by_status(list(await asyncio.gather(*map(candidate, found))))


async def _claude_settings_candidates(search: _Search) -> list[Candidate]:
    """Claude Code homes whose settings send Claude Code to DeepSeek with an API key."""
    homes = await asyncio.to_thread(cli_homes, "claude")
    candidates: list[Candidate] = []
    for home in homes:
        settings = await _read_or_none(f"{expand_path(home['accountHome'])}/settings.json")
        if settings is None or deepseek_key_from_claude_settings(settings) is None:
            continue
        added = any(
            item["app"] == "claude-settings" and _same_home(item["accountHome"], home["accountHome"])
            for item in search.configured
        )
        candidates.append(
            {
                "kind": "deepseek",
                "app": "claude-settings",
                "accountHome": home["accountHome"],
                "label": provider_label("deepseek"),
                "status": "already-added" if added else "ready",
                "duplicateOf": None,
            }
        )
    return candidates


async def _copilot_cli_candidates(search: _Search) -> list[Candidate]:
    try:
        token = await copilot_cli_token()
    except ServiceError:
        return []
    if not token:
        return []
    added = any(item["app"] == "copilot-cli" for item in search.configured)
    return [
        {
            "kind": "copilot",
            "app": "copilot-cli",
            "accountHome": "~/.copilot",
            "label": provider_label("copilot"),
            "status": "already-added" if added else "ready",
            "duplicateOf": None,
        }
    ]


def _homes(
    scan: Callable[[], list[ProviderInstance]],
) -> Callable[[_Search], Awaitable[list[Candidate]]]:
    async def find(search: _Search) -> list[Candidate]:
        return await _home_candidates(await asyncio.to_thread(scan), search)

    return find


async def _open_code_found(search: _Search) -> list[Candidate]:
    return open_code_candidates(
        search.entries, search.configured, search.identities, str(Path(open_code_auth_path()).parent)
    )


async def _nothing(_search: _Search) -> list[Candidate]:
    # A pasted key is typed in, not found.
    return []


def _codex_homes() -> list[ProviderInstance]:
    return cli_homes("codex")


def _claude_homes() -> list[ProviderInstance]:
    return cli_homes("claude")


_FINDERS: dict[AccountApp, Callable[[_Search], Awaitable[list[Candidate]]]] = {
    "codex-cli": _homes(_codex_homes),
    "claude-code": _homes(_claude_homes),
    "kiro-cli": _homes(kiro_homes),
    "antigravity": _homes(antigravity_homes),
    "kimi-cli": _homes(kimi_homes),
    "cursor": _homes(cursor_homes),
    "cursor-agent": _homes(cursor_agent_homes),
    "github-cli": _homes(github_cli_homes),
    "copilot-cli": _copilot_cli_candidates,
    "opencode": _open_code_found,
    "claude-settings": _claude_settings_candidates,
    "keyring": _nothing,
}


async def _search(configured: list[ProviderInstance]) -> _Search:
    entries = await _open_code_entries()
    return _Search(configured, await _configured_identities(configured, entries), entries)


async def find_candidates(app: AccountApp, configured: list[ProviderInstance]) -> list[Candidate]:
    """Every account that can be added from one app, read-only and without network requests."""
    return await _FINDERS[app](await _search(configured))


async def find_all_candidates(configured: list[ProviderInstance]) -> list[Candidate]:
    """Every app at once, sharing one read of OpenCode and the existing sign-ins."""
    search = await _search(configured)
    found = await asyncio.gather(*(_FINDERS[app](search) for app in ALL_APPS))
    return by_status([candidate for group in found for candidate in group])
