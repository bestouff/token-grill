import base64
import json
import os
import sqlite3
import stat
from pathlib import Path

import pytest

from tokengrill.providers import sqlite as sqlite_module
from tokengrill.providers.kiro.auth import read_kiro_auth
from tokengrill.providers.sqlite import database_stamp, query_rows, read_database

# The checks of tools/gda-test.js, against synthetic databases.


def create(path: Path, statements: list[str]) -> None:
    connection = sqlite3.connect(path)
    for statement in statements:
        connection.execute(statement)
    connection.commit()
    connection.close()


def make_kiro_database(directory: Path) -> Path:
    token = json.dumps({"access_token": "sanitized", "expires_at": "2030-01-01T00:00:00Z", "region": "eu-central-1"})
    profile = json.dumps({"arn": "arn:aws:codewhisperer:eu-central-1:1:profile/fixture", "profile_name": "fixture"})
    path = directory / "data.sqlite3"
    create(
        path,
        [
            "CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)",
            f"INSERT INTO auth_kv VALUES ('kirocli:odic:token', '{token}')",
            f"INSERT INTO state VALUES ('api.codewhisperer.profile', '{profile}')",
        ],
    )
    return path


def make_closed_wal_database(directory: Path) -> tuple[Path, str]:
    """Cursor keeps its state in write-ahead-log mode; when Cursor is closed, -wal and -shm are gone."""
    claims = base64.urlsafe_b64encode(json.dumps({"exp": 1893456000}).encode()).decode().rstrip("=")
    jwt = f"eyJhbGciOiJub25lIn0.{claims}.sanitized"
    path = directory / "state.vscdb"
    create(
        path,
        [
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            f"INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', '{jwt}')",
            "INSERT INTO ItemTable VALUES ('cursorAuth/cachedEmail', 'user@example.com')",
        ],
    )
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode = WAL")
    connection.close()
    for suffix in ("-wal", "-shm"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)
    return path, jwt


@pytest.fixture
def runtime(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path_factory.mktemp("run")
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(directory))
    return directory / "token-grill"


def listing(directory: Path) -> list[str]:
    return sorted(entry.name for entry in directory.iterdir())


async def test_kiro_database_in_a_folder_that_needs_url_quoting_is_read(tmp_path: Path) -> None:
    directory = tmp_path / "tokengrill kiro;#?%"
    directory.mkdir()
    auth = await read_kiro_auth(str(make_kiro_database(directory)))
    assert auth.access_token == "sanitized"
    assert auth.service_region == "eu-central-1"
    assert auth.profile_arn is not None


async def test_a_read_only_connection_refuses_a_write(tmp_path: Path) -> None:
    path = make_kiro_database(tmp_path)

    def write(connection: sqlite3.Connection) -> None:
        connection.execute("UPDATE auth_kv SET value = 'changed'")

    with pytest.raises(sqlite3.OperationalError):
        await read_database(str(path), write)
    assert (await query_rows(str(path), "SELECT count(*) FROM auth_kv", ())) == [(1,)]
    assert "changed" not in path.read_bytes().decode("latin-1")


async def test_a_closed_wal_database_is_read_from_a_private_copy_that_is_deleted(tmp_path: Path, runtime: Path) -> None:
    path, jwt = make_closed_wal_database(tmp_path)
    before = listing(tmp_path)
    assert before == ["state.vscdb"]
    rows = await query_rows(str(path), "SELECT value FROM ItemTable WHERE key = ?", ("cursorAuth/accessToken",))
    assert rows == [(jwt,)]
    assert listing(tmp_path) == before
    assert listing(runtime) == []


async def test_the_private_copy_folder_is_private_and_the_copy_is_0600(
    tmp_path: Path, runtime: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, _ = make_closed_wal_database(tmp_path)
    seen: list[tuple[int, int]] = []
    real = sqlite_module.open_read_only

    def spy(target: str) -> sqlite3.Connection:
        seen.append((stat.S_IMODE(os.stat(target).st_mode), stat.S_IMODE(runtime.stat().st_mode)))
        assert Path(target).parent == runtime
        return real(target)

    monkeypatch.setattr(sqlite_module, "open_read_only", spy)
    await query_rows(str(path), "SELECT 1", ())
    assert seen == [(0o600, 0o700)]


async def test_the_private_copy_is_deleted_when_the_query_fails(tmp_path: Path, runtime: Path) -> None:
    path, _ = make_closed_wal_database(tmp_path)
    with pytest.raises(sqlite3.OperationalError):
        await query_rows(str(path), "SELECT * FROM missing_table", ())
    assert listing(runtime) == []
    assert listing(tmp_path) == ["state.vscdb"]


async def test_a_non_wal_database_is_read_in_place(tmp_path: Path, runtime: Path) -> None:
    path = make_kiro_database(tmp_path)
    await query_rows(str(path), "SELECT 1", ())
    assert not runtime.exists()
    assert listing(tmp_path) == ["data.sqlite3"]


async def test_a_wal_database_with_sidecars_is_read_in_place(tmp_path: Path, runtime: Path) -> None:
    path = tmp_path / "live.db"
    writer = sqlite3.connect(path)
    writer.execute("PRAGMA journal_mode = WAL")
    writer.execute("CREATE TABLE t (v TEXT)")
    writer.execute("INSERT INTO t VALUES ('in the log')")
    writer.commit()
    try:
        assert (tmp_path / "live.db-wal").exists()
        assert (tmp_path / "live.db-shm").exists()
        assert await query_rows(str(path), "SELECT v FROM t", ()) == [("in the log",)]
        assert not runtime.exists()
    finally:
        writer.close()


async def test_stamp_changes_with_the_database_and_its_wal(tmp_path: Path) -> None:
    path = tmp_path / "live.db"
    assert await database_stamp(str(path)) is None
    writer = sqlite3.connect(path)
    writer.execute("PRAGMA journal_mode = WAL")
    writer.execute("CREATE TABLE t (v TEXT)")
    writer.commit()
    try:
        first = await database_stamp(str(path))
        assert first is not None
        assert "|" in first
        writer.execute("INSERT INTO t VALUES ('x')")
        writer.commit()
        assert await database_stamp(str(path)) != first
        assert await database_stamp(str(path)) == await database_stamp(str(path))
    finally:
        writer.close()


async def test_a_looser_existing_private_folder_is_tightened(tmp_path: Path, runtime: Path) -> None:
    path, _ = make_closed_wal_database(tmp_path)
    runtime.mkdir(mode=0o755, parents=True)
    runtime.chmod(0o755)
    await query_rows(str(path), "SELECT 1", ())
    assert stat.S_IMODE(runtime.stat().st_mode) == 0o700


async def test_a_symlinked_private_folder_is_refused(tmp_path: Path, runtime: Path) -> None:
    path, _ = make_closed_wal_database(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    runtime.parent.mkdir(parents=True, exist_ok=True)
    runtime.symlink_to(elsewhere)
    with pytest.raises(PermissionError):
        await query_rows(str(path), "SELECT 1", ())
    assert listing(elsewhere) == []


async def test_a_private_folder_of_another_user_is_refused(
    tmp_path: Path, runtime: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, _ = make_closed_wal_database(tmp_path)
    runtime.mkdir(mode=0o700, parents=True)
    monkeypatch.setattr(os, "getuid", lambda: os.stat(runtime).st_uid + 1)
    with pytest.raises(PermissionError):
        await query_rows(str(path), "SELECT 1", ())
    assert listing(runtime) == []


async def test_stale_private_copies_are_swept_and_other_files_are_kept(runtime: Path) -> None:
    runtime.mkdir(mode=0o700, parents=True)
    stale = [f"{'a' * 32}.sqlite", f"{'b' * 32}.sqlite-wal", f"{'c' * 32}.sqlite-shm"]
    for name in [*stale, "keep.txt"]:
        (runtime / name).write_bytes(b"x")
    await sqlite_module.sweep_private_copies()
    assert listing(runtime) == ["keep.txt"]


async def test_sweeping_without_a_folder_does_nothing(runtime: Path) -> None:
    await sqlite_module.sweep_private_copies()
    assert not runtime.exists()
