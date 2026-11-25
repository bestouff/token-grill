"""The GitHub token of a Copilot account, read from the app it was added from; never stored."""

from tokengrill.core.errors import ServiceError
from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.copilot.gh_hosts import parse_gh_hosts
from tokengrill.providers.credentials import read_credential_text
from tokengrill.providers.keyring import lookup_secret
from tokengrill.providers.opencode.auth_file import read_open_code_entries
from tokengrill.providers.opencode.entries import open_code_github_token

# Both CLIs store their token as a generic secret, keyed by service (gh adds the user).
GENERIC_SCHEMA = "org.freedesktop.Secret.Generic"
KEYRING_UNAVAILABLE = "copilot.keyring-unavailable"


async def _github_cli_token(instance: ProviderInstance) -> str:
    hosts = parse_gh_hosts(await read_credential_text(provider_paths(instance)["authFile"]))
    if hosts["token"]:
        return hosts["token"]
    user = hosts["user"]
    token = (
        await lookup_secret(GENERIC_SCHEMA, {"service": "gh:github.com", "username": user}, KEYRING_UNAVAILABLE)
        if user
        else None
    )
    if not token:
        raise ServiceError("auth-missing", "copilot.github-cli-missing")
    return token


async def copilot_cli_token() -> str:
    token = await lookup_secret(GENERIC_SCHEMA, {"service": "copilot-cli"}, KEYRING_UNAVAILABLE)
    if not token:
        raise ServiceError("auth-missing", "copilot.cli-missing")
    return token


async def load_copilot_token(instance: ProviderInstance) -> str:
    if instance["app"] == "opencode":
        return open_code_github_token((await read_open_code_entries()).get("github-copilot"))
    if instance["app"] == "copilot-cli":
        return await copilot_cli_token()
    return await _github_cli_token(instance)
