"""The Cursor app sign-in from its SQLite database and the Cursor CLI sign-in from `auth.json`."""

import sqlite3
import time
from dataclasses import dataclass

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import string_at
from tokengrill.core.paths import display_path, provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.credentials import CredentialStatus, credential_error_status, read_credential_json
from tokengrill.providers.cursor.normalize import is_jwt_like
from tokengrill.providers.jwt import jwt_expiry, jwt_subject
from tokengrill.providers.sqlite import database_stamp, read_database

# ItemTable declares its values as BLOB, which sqlite3 only returns as text through a cast.
_TOKEN_QUERY = "SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = 'cursorAuth/accessToken'"
_EMAIL_QUERY = "SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = 'cursorAuth/cachedEmail'"


@dataclass(frozen=True)
class CursorAuth:
    access_token: str
    # The account the token belongs to, from its `sub` claim.
    subject: str | None
    email: str | None
    expires_at: int | float | None


def _not_signed_in() -> ServiceError:
    return ServiceError("auth-missing", "cursor.auth-missing")


def _cursor_auth(access_token: str, email: str | None) -> CursorAuth:
    """Newer Cursor builds encrypt the stored token with a key from the system keyring. Token Grill
    does not decrypt another app's secrets."""
    if not is_jwt_like(access_token):
        raise ServiceError("unsupported-account", "cursor.encrypted")
    return CursorAuth(access_token, jwt_subject(access_token), email, jwt_expiry(access_token))


async def cursor_database_stamp(path: str) -> str:
    stamp = await database_stamp(path)
    if stamp is None:
        raise _not_signed_in()
    return stamp


def _first_text(connection: sqlite3.Connection, query: str) -> str | None:
    row = connection.execute(query).fetchone()
    return row[0] if row is not None and isinstance(row[0], str) else None


def _read_auth(connection: sqlite3.Connection) -> CursorAuth:
    access_token = _first_text(connection, _TOKEN_QUERY)
    if not access_token:
        raise _not_signed_in()
    return _cursor_auth(access_token, _first_text(connection, _EMAIL_QUERY) or None)


async def read_cursor_auth(path: str) -> CursorAuth:
    """Cursor renews its own sign-in while it runs; Token Grill only reads it."""
    try:
        return await read_database(path, _read_auth)
    except (sqlite3.Error, OSError):
        raise ServiceError("auth-invalid", "cursor.database-unreadable", path=display_path(path)) from None


async def read_cursor_agent_auth(path: str) -> CursorAuth:
    """`agent login` keeps its sign-in in a file of its own; the CLI renews it."""
    access_token = string_at(await read_credential_json(path), "accessToken")
    if not access_token:
        raise ServiceError("auth-missing", "cursor.cli-missing")
    return _cursor_auth(access_token, None)


def is_cursor_token_fresh(auth: CursorAuth) -> bool:
    return auth.expires_at is None or auth.expires_at > time.time() * 1000


async def cursor_credential_status(instance: ProviderInstance) -> CredentialStatus:
    path = provider_paths(instance)["authFile"]
    try:
        if instance["app"] == "cursor-agent":
            auth = await read_cursor_agent_auth(path)
        else:
            await cursor_database_stamp(path)
            auth = await read_cursor_auth(path)
    except ServiceError as error:
        return credential_error_status(error)
    return "authenticated" if is_cursor_token_fresh(auth) else "login-required"
