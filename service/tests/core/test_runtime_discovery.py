import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from tokengrill.core.config import ConfigStore, default_settings, new_provider
from tokengrill.core.errors import InvalidRequest
from tokengrill.core.runtime import Runtime
from tokengrill.core.types import (
    Alert,
    ProviderInstance,
    ProviderRuntimeState,
    ProviderSnapshot,
    Settings,
)
from tokengrill.net.http import HttpClient


class Quiet:
    def account_changed(self, account_id: str, snapshot: ProviderSnapshot, runtime: ProviderRuntimeState) -> None:
        return None

    def accounts_changed(self, accounts: list[ProviderInstance]) -> None:
        return None

    def settings_changed(self, settings: Settings) -> None:
        return None

    def alert(self, alert: Alert) -> None:
        return None


@pytest.fixture(autouse=True)
def xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))


@pytest.fixture
async def runtime(tmp_path: Path) -> AsyncIterator[Runtime]:
    keyring = {**new_provider("deepseek", "keyring", "~/.claude"), "id": "key"}
    codex = {**new_provider("codex", "codex-cli", "~/.codex"), "id": "cx"}
    store = ConfigStore(tmp_path / "config" / "token-grill" / "config.json")
    await store.save({"schema": 1, "accounts": [keyring, codex], **default_settings()})  # type: ignore[typeddict-item]
    made = Runtime(store, Quiet(), HttpClient(), {})
    await made.start()
    yield made
    await made.stop()


async def test_discover_rejects_an_unknown_app(runtime: Runtime) -> None:
    with pytest.raises(InvalidRequest):
        await runtime.discover("nonsense")


async def test_discover_empty_means_all_apps(tmp_path: Path, runtime: Runtime, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home" / ".codex"
    home.mkdir(parents=True)
    (home / "auth.json").write_text(json.dumps({"tokens": {"account_id": "a"}}), encoding="utf-8")

    async def absent() -> str:
        return ""

    monkeypatch.setattr("tokengrill.providers.discovery.copilot_cli_token", absent)
    everything = await runtime.discover("")
    assert [(item["app"], item["status"]) for item in everything] == [("codex-cli", "already-added")]
    assert await runtime.discover("kiro-cli") == []


async def test_credential_state_of_an_unknown_account_is_invalid(runtime: Runtime) -> None:
    with pytest.raises(InvalidRequest):
        await runtime.credential_state("missing")
    assert await runtime.credential_state("cx") == "login-required"


async def test_save_api_key_stores_only_for_a_keyring_account(
    runtime: Runtime, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    saved: list[tuple[str, str]] = []

    async def store(account_id: str, key: str) -> None:
        saved.append((account_id, key))

    monkeypatch.setattr("tokengrill.core.runtime.store_api_key", store)
    with caplog.at_level("DEBUG"):
        await runtime.save_api_key("key", "sk-very-secret")
    assert saved == [("key", "sk-very-secret")]
    assert "sk-very-secret" not in caplog.text
    with pytest.raises(InvalidRequest):
        await runtime.save_api_key("cx", "sk-very-secret")
    with pytest.raises(InvalidRequest):
        await runtime.save_api_key("missing", "sk-very-secret")
    with pytest.raises(InvalidRequest):
        await runtime.save_api_key("key", "  ")
    assert len(saved) == 1
