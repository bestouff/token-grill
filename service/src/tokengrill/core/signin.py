"""The command that signs an account in again, for the extension to open in a terminal."""

from collections.abc import Callable
from typing import NamedTuple

from tokengrill.core.paths import cursor_agent_home, default_home, expand_path
from tokengrill.core.types import AccountApp, ProviderInstance


class _Login(NamedTuple):
    argv: tuple[str, ...]
    # The variable that points the CLI at another home. A CLI without one is offered only for its default home.
    home_variable: str | None
    # None for an app that keeps one store for every account.
    default_home: Callable[[], str] | None


_COMMANDS: dict[AccountApp, _Login] = {
    "codex-cli": _Login(("codex", "login"), "CODEX_HOME", lambda: default_home("codex")),
    "claude-code": _Login(("claude", "auth", "login"), "CLAUDE_CONFIG_DIR", lambda: default_home("claude")),
    "github-cli": _Login(("gh", "auth", "login"), "GH_CONFIG_DIR", lambda: default_home("copilot")),
    "kiro-cli": _Login(("kiro-cli", "login"), None, lambda: default_home("kiro")),
    "cursor-agent": _Login(("agent", "login"), None, cursor_agent_home),
    "opencode": _Login(("opencode", "auth", "login"), None, None),
}


def sign_in_command(instance: ProviderInstance) -> tuple[list[str], dict[str, str]] | None:
    """The argv and the extra environment, or None when Token Grill cannot start the right login."""
    login = _COMMANDS.get(instance["app"])
    if login is None:
        return None
    argv = list(login.argv)
    if login.default_home is None:
        return argv, {}
    home = expand_path(instance["accountHome"])
    if home == login.default_home():
        return argv, {}
    if login.home_variable is None:
        return None
    return argv, {login.home_variable: home}
