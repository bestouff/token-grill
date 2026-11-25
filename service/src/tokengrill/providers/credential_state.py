"""What the preferences show next to an account: whether its sign-in can be read and is still valid.

The states keep the names of 0.4.1 so the extension's labels map one to one; `gda-missing` is gone
because sqlite3 is always present.
"""

from collections.abc import Awaitable, Callable
from typing import Literal

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, ProviderKind
from tokengrill.providers.antigravity.auth import antigravity_credential_status
from tokengrill.providers.claude.auth import load_claude_access_token
from tokengrill.providers.codex.auth import load_codex_access_token
from tokengrill.providers.copilot.auth import load_copilot_token
from tokengrill.providers.credentials import CredentialStatus
from tokengrill.providers.cursor.auth import cursor_credential_status
from tokengrill.providers.deepseek.auth import load_deepseek_key
from tokengrill.providers.kimi.auth import load_kimi_auth
from tokengrill.providers.kiro.auth import kiro_credential_status
from tokengrill.providers.opencode_go.auth import load_open_code_go_key

CredentialState = Literal[
    "authenticated",
    "expired",
    "expired-refreshable",
    "expired-external",
    "login-required",
    "unreadable",
    "database-unreadable",
    "keyring-unavailable",
]


async def _file_state(load: Awaitable[object]) -> CredentialState:
    try:
        await load
    except ServiceError as error:
        if error.code == "auth-expired":
            return "expired"
        if error.code in ("auth-invalid", "permission"):
            return "unreadable"
        if error.code == "dependency":
            return "keyring-unavailable"
        return "login-required"
    return "authenticated"


async def _database_state(check: Awaitable[CredentialStatus]) -> CredentialState:
    status = await check
    # A local database has no dependency that can be missing.
    return "database-unreadable" if status == "dependency-missing" else status


async def _antigravity_state(instance: ProviderInstance) -> CredentialState:
    status = await antigravity_credential_status(instance)
    if status == "dependency-missing":
        return "keyring-unavailable"
    return "unreadable" if status == "database-unreadable" else status


_CHECKS: dict[ProviderKind, Callable[[ProviderInstance], Awaitable[CredentialState]]] = {
    "codex": lambda instance: _file_state(load_codex_access_token(instance)),
    "claude": lambda instance: _file_state(load_claude_access_token(instance)),
    "kiro": lambda instance: _database_state(kiro_credential_status(instance)),
    "antigravity": _antigravity_state,
    "copilot": lambda instance: _file_state(load_copilot_token(instance)),
    "opencode-go": lambda _instance: _file_state(load_open_code_go_key()),
    "deepseek": lambda instance: _file_state(load_deepseek_key(instance)),
    "kimi": lambda instance: _file_state(load_kimi_auth(instance)),
    "cursor": lambda instance: _database_state(cursor_credential_status(instance)),
}


async def credential_state(instance: ProviderInstance) -> CredentialState:
    """Raises only on a bug: every expected failure of reading a sign-in is a state."""
    return await _CHECKS[instance["kind"]](instance)
