import os
from pathlib import Path

import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.providers.credentials import credential_error_status, read_credential_json, read_credential_text


async def test_reads_text_and_json(tmp_path: Path) -> None:
    path = tmp_path / "auth.json"
    path.write_text('{"token": "abc"}')
    assert await read_credential_text(str(path)) == '{"token": "abc"}'
    assert await read_credential_json(str(path)) == {"token": "abc"}


async def test_missing_file_is_auth_missing(tmp_path: Path) -> None:
    with pytest.raises(ServiceError) as raised:
        await read_credential_text(str(tmp_path / "none.json"))
    assert raised.value.code == "auth-missing"
    assert raised.value.message_id == "config.no-credentials"


async def test_unreadable_file_is_permission(tmp_path: Path) -> None:
    path = tmp_path / "auth.json"
    path.write_text("{}")
    path.chmod(0)
    if os.access(path, os.R_OK):
        pytest.skip("permissions are not enforced for this user")
    with pytest.raises(ServiceError) as raised:
        await read_credential_text(str(path))
    assert raised.value.code == "permission"
    assert raised.value.message_id == "config.not-allowed"


async def test_directory_and_oversized_files_are_not_credential_files(tmp_path: Path) -> None:
    with pytest.raises(ServiceError) as raised:
        await read_credential_text(str(tmp_path))
    assert (raised.value.code, raised.value.message_id) == ("auth-invalid", "config.not-credential-file")
    big = tmp_path / "big.json"
    big.write_bytes(b"x" * 11)
    with pytest.raises(ServiceError) as raised_big:
        await read_credential_text(str(big), max_bytes=10)
    assert raised_big.value.message_id == "config.not-credential-file"


async def test_non_record_json_is_invalid_credentials(tmp_path: Path) -> None:
    path = tmp_path / "auth.json"
    for text in ("[1]", "not json", ""):
        path.write_text(text)
        with pytest.raises(ServiceError) as raised:
            await read_credential_json(str(path))
        assert (raised.value.code, raised.value.message_id) == ("auth-invalid", "config.invalid-credentials")


async def test_error_params_show_the_home_relative_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(ServiceError) as raised:
        await read_credential_text(str(tmp_path / ".codex" / "auth.json"))
    assert raised.value.params == {"path": "~/.codex/auth.json"}


def test_credential_error_status_maps_codes() -> None:
    assert credential_error_status(ServiceError("dependency", "sqlite.gda-missing")) == "dependency-missing"
    assert credential_error_status(ServiceError("auth-missing", "config.no-credentials")) == "login-required"
    assert credential_error_status(ServiceError("permission", "config.not-allowed")) == "database-unreadable"
    with pytest.raises(RuntimeError):
        credential_error_status(RuntimeError("bug"))
