import sys
from pathlib import Path

import pytest

from tokengrill.cli import main

SERVICE_FILE = "dbus-1/services/io.github.sh02sahil.TokenGrill.service"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for name in ("CONFIG", "DATA", "STATE", "CACHE"):
        monkeypatch.setenv(f"XDG_{name}_HOME", str(tmp_path / name.lower()))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("DBUS_SESSION_BUS_ADDRESS", f"unix:path={tmp_path}/no-such-bus")
    return tmp_path


def test_setup_writes_service_file_with_absolute_python(home: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["setup"]) == 0
    written = (home / "data" / SERVICE_FILE).read_text(encoding="ascii")
    assert written == (
        f"[D-BUS Service]\nName=io.github.sh02sahil.TokenGrill\nExec={sys.executable} -m tokengrill run\n"
    )
    assert Path(sys.executable).is_absolute()
    assert "Token Grill will start the service when it needs it." in capsys.readouterr().out


def test_setup_is_idempotent(home: Path) -> None:
    assert main(["setup"]) == 0
    first = (home / "data" / SERVICE_FILE).read_text(encoding="ascii")
    assert main(["setup"]) == 0
    assert (home / "data" / SERVICE_FILE).read_text(encoding="ascii") == first


def test_setup_without_a_session_bus_still_writes_and_notes(home: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["setup"]) == 0
    assert (home / "data" / SERVICE_FILE).exists()
    assert "next login" in capsys.readouterr().out


def test_uninstall_removes_file(home: Path) -> None:
    main(["setup"])
    assert main(["uninstall"]) == 0
    assert not (home / "data" / SERVICE_FILE).exists()
    assert main(["uninstall"]) == 0


def _make_folders(home: Path) -> list[Path]:
    folders = [home / "config" / "token-grill", home / "data" / "token-grill", home / "state" / "token-grill"]
    for folder in folders:
        folder.mkdir(parents=True)
        (folder / "x.json").write_text("{}", encoding="ascii")
    return folders


def test_purge_asks_before_deleting(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folders = _make_folders(home)
    prompts: list[str] = []

    def refuse(prompt: str) -> str:
        prompts.append(prompt)
        return "n"

    monkeypatch.setattr("builtins.input", refuse)
    assert main(["uninstall", "--purge"]) == 0
    assert prompts == ["Also delete the accounts and history? [y/N] "]
    assert all(folder.exists() for folder in folders)

    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    assert main(["uninstall", "--purge"]) == 0
    assert not any(folder.exists() for folder in folders)


def test_purge_without_an_answer_keeps_everything(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folders = _make_folders(home)

    def eof(prompt: str) -> str:
        raise EOFError

    monkeypatch.setattr("builtins.input", eof)
    assert main(["uninstall", "--purge"]) == 0
    assert all(folder.exists() for folder in folders)
