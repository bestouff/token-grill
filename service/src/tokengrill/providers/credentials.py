"""Read-only access to the credential files of other tools."""

import asyncio
import stat
from pathlib import Path
from typing import Literal

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import parse_record
from tokengrill.core.paths import display_path

MAX_CREDENTIAL_BYTES = 1024 * 1024

# The answers the preferences show for credentials they cannot check by reading a single file.
CredentialStatus = Literal[
    "authenticated",
    "expired-refreshable",
    "expired-external",
    "login-required",
    "database-unreadable",
    "dependency-missing",
]


def credential_error_status(error: BaseException) -> CredentialStatus:
    if not isinstance(error, ServiceError):
        raise error
    if error.code == "dependency":
        return "dependency-missing"
    if error.code == "auth-missing":
        return "login-required"
    return "database-unreadable"


def credential_file_error(error: OSError, path: str) -> ServiceError:
    """Maps the expected failures of reading another tool's file."""
    shown = display_path(path)
    if isinstance(error, FileNotFoundError):
        return ServiceError("auth-missing", "config.no-credentials", path=shown)
    if isinstance(error, PermissionError):
        return ServiceError("permission", "config.not-allowed", path=shown)
    return ServiceError("auth-invalid", "config.unreadable", path=shown)


def _read(path: str, max_bytes: int) -> bytes:
    shown = display_path(path)
    try:
        with Path(path).open("rb") as handle:
            info = Path(path).stat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
                raise ServiceError("auth-invalid", "config.not-credential-file", path=shown)
            contents = handle.read(max_bytes + 1)
    except OSError as error:
        if isinstance(error, IsADirectoryError):
            raise ServiceError("auth-invalid", "config.not-credential-file", path=shown) from None
        raise credential_file_error(error, path) from None
    if len(contents) > max_bytes:
        raise ServiceError("auth-invalid", "config.not-credential-file", path=shown)
    return contents


async def read_credential_text(path: str, max_bytes: int = MAX_CREDENTIAL_BYTES) -> str:
    contents = await asyncio.to_thread(_read, path, max_bytes)
    return contents.decode("utf-8-sig", errors="replace")


async def read_credential_json(path: str, max_bytes: int = MAX_CREDENTIAL_BYTES) -> dict[str, object]:
    payload = parse_record(await read_credential_text(path, max_bytes))
    if payload is None:
        raise ServiceError("auth-invalid", "config.invalid-credentials", path=display_path(path))
    return payload
