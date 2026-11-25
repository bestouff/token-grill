"""The kiro-cli sign-in, read from its SQLite database and refreshed in memory only."""

import sqlite3
import time
from dataclasses import dataclass

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import parse_record, string_at, to_epoch_ms
from tokengrill.core.paths import display_path, provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.credentials import CredentialStatus, credential_error_status
from tokengrill.providers.kiro.endpoints import is_kiro_service_region
from tokengrill.providers.sqlite import database_stamp, read_database

# A token this close to expiry is refreshed first, so it cannot expire in flight.
TOKEN_SKEW_MS = 60 * 1000
# Builder ID sign-ins carry no profile and are served from us-east-1.
DEFAULT_SERVICE_REGION = "us-east-1"

# kiro-cli spells its OIDC keys "odic".
_TOKEN_QUERY = "SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'"
_REGISTRATION_QUERY = "SELECT value FROM auth_kv WHERE key = 'kirocli:odic:device-registration'"
# The state table declares its values as BLOB; the cast returns them as text.
_PROFILE_QUERY = "SELECT CAST(value AS TEXT) FROM state WHERE key = 'api.codewhisperer.profile'"


@dataclass(frozen=True)
class KiroAuth:
    access_token: str
    refresh_token: str | None
    expires_at: int | float
    region: str
    service_region: str
    client_id: str | None
    client_secret: str | None
    client_secret_expires_at: int | float | None
    profile_arn: str | None


@dataclass(frozen=True)
class KiroAuthRecords:
    token: str | None
    registration: str | None
    profile: str | None


def _invalid_record() -> ServiceError:
    return ServiceError("auth-invalid", "kiro.auth-unreadable")


def _not_signed_in() -> ServiceError:
    return ServiceError("auth-missing", "kiro.auth-missing")


def parse_kiro_auth_records(records: KiroAuthRecords) -> KiroAuth:
    if not records.token:
        raise _not_signed_in()
    token = parse_record(records.token)
    registration = parse_record(records.registration) if records.registration else {}
    if token is None or registration is None:
        raise _invalid_record()
    access_token = string_at(token, "access_token")
    region = string_at(token, "region") or string_at(registration, "region")
    expires_at = to_epoch_ms(token.get("expires_at"))
    if not access_token:
        raise _not_signed_in()
    if not region or expires_at is None:
        raise _invalid_record()
    profile = parse_record(records.profile) if records.profile else None
    profile_arn = string_at(profile, "arn") if profile else None
    parts = (profile_arn or "").split(":")
    arn_region = parts[3] if len(parts) > 3 else ""
    service_region = DEFAULT_SERVICE_REGION
    if is_kiro_service_region(arn_region):
        service_region = arn_region
    elif is_kiro_service_region(region):
        service_region = region
    return KiroAuth(
        access_token=access_token,
        refresh_token=string_at(token, "refresh_token"),
        expires_at=expires_at,
        region=region,
        service_region=service_region,
        client_id=string_at(registration, "client_id"),
        client_secret=string_at(registration, "client_secret"),
        client_secret_expires_at=to_epoch_ms(registration.get("client_secret_expires_at")),
        profile_arn=profile_arn,
    )


def _now_ms() -> float:
    return time.time() * 1000


def is_kiro_token_fresh(expires_at: float, now: float | None = None) -> bool:
    return expires_at > (_now_ms() if now is None else now) + TOKEN_SKEW_MS


def is_kiro_refreshable(auth: KiroAuth, now: float | None = None) -> bool:
    current = _now_ms() if now is None else now
    registration_valid = auth.client_secret_expires_at is None or auth.client_secret_expires_at > current
    return bool(auth.refresh_token and auth.client_id and auth.client_secret) and registration_valid


async def kiro_database_stamp(path: str) -> str:
    stamp = await database_stamp(path)
    if stamp is None:
        raise _not_signed_in()
    return stamp


def _first_text(connection: sqlite3.Connection, query: str) -> str | None:
    row = connection.execute(query).fetchone()
    return row[0] if row is not None and isinstance(row[0], str) else None


def _read_records(connection: sqlite3.Connection) -> KiroAuthRecords:
    return KiroAuthRecords(
        token=_first_text(connection, _TOKEN_QUERY),
        registration=_first_text(connection, _REGISTRATION_QUERY),
        profile=_first_text(connection, _PROFILE_QUERY),
    )


async def read_kiro_auth(path: str) -> KiroAuth:
    """Errors of the database (a missing table, a corrupt file) become `auth-invalid`."""
    try:
        records = await read_database(path, _read_records)
    except (sqlite3.Error, OSError):
        raise ServiceError("auth-invalid", "kiro.database-unreadable", path=display_path(path)) from None
    return parse_kiro_auth_records(records)


async def kiro_credential_status(instance: ProviderInstance) -> CredentialStatus:
    path = provider_paths(instance)["authFile"]
    try:
        await kiro_database_stamp(path)
        auth = await read_kiro_auth(path)
    except ServiceError as error:
        return credential_error_status(error)
    if is_kiro_token_fresh(auth.expires_at):
        return "authenticated"
    return "expired-refreshable" if is_kiro_refreshable(auth) else "login-required"
