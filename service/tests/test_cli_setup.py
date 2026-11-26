import shutil
import sys
from pathlib import Path

import pytest

from tokengrill.cli import main

SERVICE_FILE = "dbus-1/services/io.github.sh02sahil.TokenGrill.service"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for name in ("CONFIG", "DATA", "STATE", "CACHE"):
        monkeypatch.setenv(f"XDG_{name}_HOME", str(tmp_path / name.lower()))
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("DBUS_SESSION_BUS_ADDRESS", f"unix:path={tmp_path}/no-such-bus")
    return tmp_path


def test_setup_runs_the_console_script_beside_python(home: Path, capsys: pytest.CaptureFixture[str]) -> None:
    script = Path(sys.executable).parent / "tokengrill"
    assert script.is_file(), "the test environment installs the console script"
    assert main(["setup"]) == 0
    written = (home / "data" / SERVICE_FILE).read_text(encoding="utf-8")
    assert written == f'[D-BUS Service]\nName=io.github.sh02sahil.TokenGrill\nExec="{script}" run\n'
    assert Path(sys.executable).is_absolute()
    assert "Token Grill will start the service when it needs it." in capsys.readouterr().out


def test_setup_without_a_console_script_runs_the_module(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = home / "python only"
    folder.mkdir()
    monkeypatch.setattr(sys, "executable", str(folder / "python3"))
    assert main(["setup"]) == 0
    written = (home / "data" / SERVICE_FILE).read_text(encoding="utf-8")
    assert written.endswith(f'\nExec="{folder}/python3" -m tokengrill run\n')


def test_setup_quotes_a_path_with_spaces_and_non_ascii(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # An e-acute, which is not ASCII (the file stays ASCII).
    folder = home / f"a b {chr(0xE9)} 'q' $HOME %h"
    folder.mkdir()
    (folder / "tokengrill").write_text("#!/bin/sh\n", encoding="ascii")
    (folder / "tokengrill").chmod(0o755)
    monkeypatch.setattr(sys, "executable", str(folder / "python3"))
    assert main(["setup"]) == 0
    written = (home / "data" / SERVICE_FILE).read_bytes().decode("utf-8")
    assert written.endswith(f'\nExec="{folder}/tokengrill" run\n')


@pytest.mark.parametrize("name", ['a "q"', "a\\b", "a\nb", "a\rb"])
def test_setup_refuses_a_path_the_bus_cannot_read(
    home: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], name: str
) -> None:
    monkeypatch.setattr(sys, "executable", str(home / name / "python3"))
    assert main(["setup"]) == 1
    assert not (home / "data" / SERVICE_FILE).exists()
    assert "Install tokengrill in another folder" in capsys.readouterr().err


def test_setup_is_idempotent(home: Path) -> None:
    assert main(["setup"]) == 0
    first = (home / "data" / SERVICE_FILE).read_text(encoding="utf-8")
    assert main(["setup"]) == 0
    assert (home / "data" / SERVICE_FILE).read_text(encoding="utf-8") == first


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
    folders = [
        home / "config" / "token-grill",
        home / "data" / "token-grill",
        home / "state" / "token-grill",
        # The private database copies.
        home / "run" / "token-grill",
    ]
    for folder in folders:
        folder.mkdir(parents=True)
        (folder / "x.json").write_text("{}", encoding="ascii")
    return folders


@pytest.fixture
def removed_keys(monkeypatch: pytest.MonkeyPatch) -> list[bool]:
    calls: list[bool] = []

    def remove() -> int:
        calls.append(True)
        return 2

    monkeypatch.setattr("tokengrill.providers.keyring.remove_all_api_keys", remove)
    return calls


def test_purge_asks_before_deleting(
    home: Path, monkeypatch: pytest.MonkeyPatch, removed_keys: list[bool], capsys: pytest.CaptureFixture[str]
) -> None:
    folders = _make_folders(home)
    prompts: list[str] = []

    def refuse(prompt: str) -> str:
        prompts.append(prompt)
        return "n"

    monkeypatch.setattr("builtins.input", refuse)
    assert main(["uninstall", "--purge"]) == 0
    assert prompts == ["Also delete the accounts, the history and the pasted API keys? [y/N] "]
    assert all(folder.exists() for folder in folders)
    assert removed_keys == []

    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    assert main(["uninstall", "--purge"]) == 0
    assert not any(folder.exists() for folder in folders)
    assert removed_keys == [True]
    assert "Deleted 2 pasted API key(s) from the keyring." in capsys.readouterr().out


def test_purge_without_an_answer_keeps_everything(
    home: Path, monkeypatch: pytest.MonkeyPatch, removed_keys: list[bool]
) -> None:
    folders = _make_folders(home)

    def eof(prompt: str) -> str:
        raise EOFError

    monkeypatch.setattr("builtins.input", eof)
    assert main(["uninstall", "--purge"]) == 0
    assert all(folder.exists() for folder in folders)
    assert removed_keys == []


def test_purge_deletes_nothing_while_the_service_keeps_running(
    home: Path, monkeypatch: pytest.MonkeyPatch, removed_keys: list[bool], capsys: pytest.CaptureFixture[str]
) -> None:
    folders = _make_folders(home)
    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    monkeypatch.setattr("tokengrill.cli._stop_service", lambda: False)
    assert main(["uninstall", "--purge"]) == 1
    assert all(folder.exists() for folder in folders)
    assert removed_keys == []
    assert "nothing is deleted" in capsys.readouterr().err


def test_purge_reports_a_folder_it_could_not_delete(
    home: Path, monkeypatch: pytest.MonkeyPatch, removed_keys: list[bool], capsys: pytest.CaptureFixture[str]
) -> None:
    folders = _make_folders(home)
    delete = shutil.rmtree

    def refuse_state(path: Path) -> None:
        if path == folders[2]:
            raise PermissionError(13, "Permission denied", str(path))
        delete(path)

    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    monkeypatch.setattr("tokengrill.cli.shutil.rmtree", refuse_state)
    assert main(["uninstall", "--purge"]) == 1
    assert [folder.exists() for folder in folders] == [False, False, True, False]
    captured = capsys.readouterr()
    assert f"{folders[2]} could not be deleted: Permission denied" in captured.err
    assert "The accounts and history are deleted." not in captured.out


def test_purge_skips_folders_that_do_not_exist(
    home: Path, monkeypatch: pytest.MonkeyPatch, removed_keys: list[bool], capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    assert main(["uninstall", "--purge"]) == 0
    assert "The accounts and history are deleted." in capsys.readouterr().out


def test_purge_names_the_key_items_when_the_keyring_cannot_be_reached(
    home: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    folders = _make_folders(home)

    def unreachable() -> int:
        raise OSError("no keyring")

    monkeypatch.setattr("tokengrill.providers.keyring.remove_all_api_keys", unreachable)
    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    assert main(["uninstall", "--purge"]) == 0
    assert not any(folder.exists() for folder in folders)
    assert 'Delete the items "Token Grill: DeepSeek API key"' in capsys.readouterr().out
