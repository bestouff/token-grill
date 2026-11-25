"""The Antigravity sign-in: the app's credential files or the agy CLI's keyring item."""

import time
from dataclasses import dataclass
from typing import Literal

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import number_at, string_at, to_epoch_ms
from tokengrill.core.paths import auth_file_candidates
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.antigravity.keyring_auth import lookup_agy_keyring_token
from tokengrill.providers.credentials import CredentialStatus, credential_error_status, read_credential_json

# A token this close to expiry is refreshed first, so it cannot expire in flight.
TOKEN_SKEW_MS = 60 * 1000


@dataclass(frozen=True)
class AntigravityAuth:
    """File credentials from the Antigravity app carry an OAuth client and can be refreshed here; the agy
    CLI's keyring token can only be renewed by agy itself."""

    source: Literal["file", "keyring"]
    client_id: str | None
    client_secret: str | None
    refresh_token: str | None
    access_token: str | None
    expires_at: int | float | None


def is_antigravity_refreshable(auth: AntigravityAuth) -> bool:
    return bool(auth.refresh_token and auth.client_id and auth.client_secret)


def is_antigravity_token_fresh(auth: AntigravityAuth) -> bool:
    return (
        bool(auth.access_token) and auth.expires_at is not None and auth.expires_at > time.time() * 1000 + TOKEN_SKEW_MS
    )


def _not_signed_in() -> ServiceError:
    return ServiceError("auth-missing", "antigravity.auth-missing")


async def _load_file_auth(instance: ProviderInstance) -> AntigravityAuth:
    for path in auth_file_candidates(instance):
        try:
            # The first file that exists wins, so they are read in order.
            payload = await read_credential_json(path)
        except ServiceError as error:
            if error.code != "auth-missing":
                raise
            continue
        auth = AntigravityAuth(
            source="file",
            client_id=string_at(payload, "client_id"),
            client_secret=string_at(payload, "client_secret"),
            refresh_token=string_at(payload, "refresh_token"),
            access_token=string_at(payload, "access_token"),
            expires_at=to_epoch_ms(number_at(payload, "expiry_date")),
        )
        if not auth.access_token and not auth.refresh_token:
            raise _not_signed_in()
        return auth
    raise _not_signed_in()


async def _load_keyring_auth() -> AntigravityAuth | None:
    token = await lookup_agy_keyring_token()
    if token is None:
        return None
    return AntigravityAuth(
        source="keyring",
        client_id=None,
        client_secret=None,
        refresh_token=token["refreshToken"],
        access_token=token["accessToken"],
        expires_at=token["expiresAt"],
    )


async def resolve_antigravity_auth(instance: ProviderInstance) -> AntigravityAuth:
    """A usable credential file wins, because it can be refreshed without the user. Otherwise a live
    keyring token takes over from a stale file, so an account signed in through agy keeps working."""
    file: AntigravityAuth | None = None
    file_error: ServiceError | None = None
    try:
        file = await _load_file_auth(instance)
    except ServiceError as error:
        file_error = error
    if file is not None and (is_antigravity_token_fresh(file) or is_antigravity_refreshable(file)):
        return file
    keyring: AntigravityAuth | None = None
    keyring_error: ServiceError | None = None
    try:
        keyring = await _load_keyring_auth()
    except ServiceError as error:
        keyring_error = error
    if keyring is not None and (file is None or is_antigravity_token_fresh(keyring)):
        return keyring
    if file is not None:
        return file
    # A broken keyring explains more than the missing file it stands in for.
    raise keyring_error or file_error or _not_signed_in()


async def antigravity_credential_status(instance: ProviderInstance) -> CredentialStatus:
    try:
        auth = await resolve_antigravity_auth(instance)
    except ServiceError as error:
        return credential_error_status(error)
    if is_antigravity_token_fresh(auth):
        return "authenticated"
    if is_antigravity_refreshable(auth):
        return "expired-refreshable"
    return "expired-external" if auth.source == "keyring" else "login-required"
