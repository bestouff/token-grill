import copy
import json
import stat
from pathlib import Path
from typing import Any

from tokengrill.core.config import (
    CONFIGURATION_VERSION,
    DEFAULT_STEP_PERCENT,
    ConfigStore,
    LegacySettings,
    import_legacy,
    migrate_provider_settings,
    needs_refresh,
    new_provider,
    normalize_provider,
)


def legacy(entries: list[dict[str, Any]], version: int = CONFIGURATION_VERSION, active: str = "") -> LegacySettings:
    return {
        "providerInstancesJson": json.dumps(entries),
        "configurationVersion": version,
        "activeProviderId": active,
        "refreshIntervalSeconds": 300,
        "notificationsEnabled": True,
        "notificationStepPercent": 10,
        "diagnosticsJournal": False,
    }


def entry(**overrides: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "id": "a",
        "kind": "codex",
        "displayName": "Personal",
        "accountHome": "~/.codex",
        **overrides,
    }


def v031(account_id: str, kind: str, preference: str, **extra: Any) -> dict[str, Any]:
    """The shape of a real 0.3.1 entry: showInPanel and panelWindowPreference."""
    home = "/home/test/.local/share/kiro-cli" if kind == "kiro" else f"~/.{kind}-{account_id}"
    return {
        "schemaVersion": 2,
        "id": account_id,
        "kind": kind,
        "displayName": f"Account {account_id}",
        "accent": "blue",
        "enabled": True,
        "showInPanel": True,
        "sortOrder": int(account_id[1:]),
        "accountHome": home,
        "authFileOverride": None,
        "sessionsDirectoryOverride": None,
        "liveUsageEnabled": True,
        "localHistoryEnabled": kind == "codex",
        "panelWindowPreference": preference,
        **extra,
    }


def real_configuration() -> list[dict[str, Any]]:
    return [
        v031("a0", "claude", "five-hour", accent="orange"),
        v031("a1", "codex", "five-hour"),
        v031("a2", "codex", "five-hour", accent="teal"),
        v031("a3", "codex", "five-hour", accent="green"),
        v031("a4", "kiro", "monthly", accent="purple"),
        v031("a5", "antigravity", "automatic", accent="teal"),
        v031("a6", "claude", "five-hour", accent="red"),
    ]


def migrated(entries: list[dict[str, Any]], version: int = 2, active: str = "a1") -> list[Any]:
    return migrate_provider_settings(legacy(entries, version, active))


def test_independent_codex_homes_remain_independent_provider_instances() -> None:
    providers = migrated([entry(), entry(id="b", displayName="Work", accountHome="~/.codex2")], 3)
    assert [p["id"] for p in providers] == ["a", "b"]
    assert providers[0]["accountHome"] != providers[1]["accountHome"]


def test_invalid_kinds_schema_versions_and_homes_are_rejected() -> None:
    assert normalize_provider(entry(kind="not-a-service")) == []
    assert normalize_provider(entry(schemaVersion=3)) == []
    assert normalize_provider(entry(accountHome="relative/home")) == []
    assert normalize_provider("text") == []


def test_invalid_override_paths_are_dropped_rather_than_rejecting_the_account() -> None:
    [provider] = normalize_provider(entry(authFileOverride="relative.json", sessionsDirectoryOverride="~/sessions"))
    assert provider["authFileOverride"] is None
    assert provider["sessionsDirectoryOverride"] == "~/sessions"


def test_a_single_window_account_upgrades_to_its_only_limit() -> None:
    [kiro] = migrated([v031("k1", "kiro", "weekly")], 2, "k1")
    assert kiro["topBar"] == {"automatic": False, "limits": ["monthly"]}
    assert kiro["localHistoryEnabled"] is False


def test_legacy_entries_are_migrated_once_and_the_result_is_stable() -> None:
    [first] = migrated([entry(schemaVersion=1, accent="not-a-colour")], 1, "")
    assert first["schemaVersion"] == 2
    again = migrate_provider_settings(legacy([dict(first)], CONFIGURATION_VERSION))
    assert again == [first]


def test_a_legacy_value_with_an_unreadable_entry_is_not_migrated() -> None:
    stored = [entry(schemaVersion=1), entry(schemaVersion=1, id="b", kind="not-a-service")]
    result = migrated(stored, 1, "")
    assert [p["id"] for p in result] == ["a"]
    assert result[0]["topBar"] == {"automatic": False, "limits": []}


def test_a_real_031_configuration_keeps_every_account_and_the_bar_looks_the_same() -> None:
    result = migrated(real_configuration())
    assert [p["id"] for p in result] == ["a0", "a1", "a2", "a3", "a4", "a5", "a6"]
    assert [p["accent"] for p in result] == ["orange", "blue", "teal", "green", "purple", "teal", "red"]
    assert [p["localHistoryEnabled"] for p in result] == [False, True, True, True, False, False, False]
    assert next(p for p in result if p["id"] == "a1")["topBar"] == {"automatic": False, "limits": ["five-hour"]}
    for provider in (p for p in result if p["id"] != "a1"):
        assert provider["topBar"] == {"automatic": False, "limits": []}


def test_migration_turns_an_automatic_active_account_into_automatic() -> None:
    result = migrated(real_configuration(), 2, "a5")
    assert next(p for p in result if p["id"] == "a5")["topBar"] == {"automatic": True, "limits": []}


def test_migration_without_a_stored_active_account_uses_the_first_enabled_account() -> None:
    assert migrated(real_configuration(), 2, "")[0]["topBar"] == {"automatic": False, "limits": ["five-hour"]}


def test_migration_without_a_stored_active_account_follows_the_account_03x_showed() -> None:
    accounts = [{**item, "showInPanel": item["id"] == "a4"} for item in real_configuration()]
    result = migrated(accounts, 2, "")
    assert next(p for p in result if p["id"] == "a4")["topBar"] == {"automatic": False, "limits": ["monthly"]}


def test_migration_gives_existing_accounts_their_native_app() -> None:
    result = migrated(real_configuration())
    assert [p["app"] for p in result] == [
        "claude-code",
        "codex-cli",
        "codex-cli",
        "codex-cli",
        "kiro-cli",
        "antigravity",
        "claude-code",
    ]


def test_migrated_entries_stay_readable_by_03x() -> None:
    for stored in migrated(real_configuration()):
        assert stored["schemaVersion"] == 2
        assert isinstance(stored["id"], str)
        assert stored["kind"] in ["codex", "claude", "kiro", "antigravity"]
        assert isinstance(stored["accountHome"], str)


def test_migration_runs_once() -> None:
    once = migrated(real_configuration())
    again = migrate_provider_settings(legacy(json.loads(json.dumps(once)), CONFIGURATION_VERSION, "a0"))
    assert again == once


def test_a_top_bar_choice_stored_before_the_version_bump_survives_migration() -> None:
    accounts = [v031("a1", "codex", "five-hour", topBar={"automatic": False, "limits": ["weekly"]})]
    assert migrated(accounts)[0]["topBar"] == {"automatic": False, "limits": ["weekly"]}


def test_malformed_accents_fall_back_to_the_service_default() -> None:
    for accent in ["#12345", "#GGGGGG", "mauve", 42]:
        assert normalize_provider(entry(accent=accent))[0]["accent"] == "green"
    assert normalize_provider(entry(accent="#A1B2C3"))[0]["accent"] == "#a1b2c3"
    assert normalize_provider(entry(accent="cyan"))[0]["accent"] == "teal"


def test_an_unknown_app_falls_back_to_the_first_supported_app() -> None:
    assert normalize_provider(entry(app="vscode"))[0]["app"] == "codex-cli"


def test_stored_top_bar_limits_survive_normalization_and_non_string_keys_are_dropped() -> None:
    top_bar = {"automatic": False, "limits": ["weekly", 7, "seven_day_opus", "weekly"]}
    [provider] = normalize_provider(entry(topBar=top_bar))
    assert provider["topBar"] == {"automatic": False, "limits": ["weekly", "seven_day_opus"]}


def test_new_accounts_start_on_automatic() -> None:
    provider = new_provider("codex", "codex-cli", "~/.codex")
    assert provider["topBar"] == {"automatic": True, "limits": []}
    assert provider["app"] == "codex-cli"
    assert provider["lowBalance"] is None
    assert provider["id"] != new_provider("codex", "codex-cli", "~/.codex")["id"]


def test_a_keyring_account_needs_no_home_other_accounts_do() -> None:
    assert len(normalize_provider(entry(kind="deepseek", app="keyring", accountHome=""))) == 1
    assert normalize_provider(entry(kind="codex", app="codex-cli", accountHome="")) == []


def test_an_upgraded_limit_the_service_never_reports_becomes_automatic() -> None:
    assert migrated([v031("a1", "codex", "monthly")])[0]["topBar"] == {"automatic": True, "limits": []}


def test_only_changes_to_how_an_account_is_read_start_a_refresh() -> None:
    [base] = normalize_provider(v031("a1", "codex", "weekly"))
    assert needs_refresh(None, base) is True
    for change in [
        {"displayName": "Renamed"},
        {"accent": "red"},
        {"topBar": {"automatic": True, "limits": []}},
        {"lowBalance": 5.0},
    ]:
        assert needs_refresh(base, {**base, **change}) is False, change  # type: ignore[typeddict-item]
    for change in [
        {"accountHome": "~/.codex2"},
        {"liveUsageEnabled": False},
        {"localHistoryEnabled": False},
        {"app": "opencode"},
        {"authFileOverride": "/x"},
    ]:
        assert needs_refresh(base, {**base, **change}) is True, change  # type: ignore[typeddict-item]
    assert needs_refresh({**base, "enabled": False}, base) is True


LEGACY_04 = legacy(
    [
        entry(topBar={"automatic": False, "limits": ["weekly"]}, sortOrder=1),
        entry(
            id="b", displayName="Work", accountHome="~/.codex2", topBar={"automatic": True, "limits": []}, sortOrder=0
        ),
    ]
)
LEGACY_03 = legacy(real_configuration(), 2, "a1")
EXPECTED_03_TOP_BAR = [
    {"automatic": False, "limits": []},
    {"automatic": False, "limits": ["five-hour"]},
    {"automatic": False, "limits": []},
    {"automatic": False, "limits": []},
    {"automatic": False, "limits": []},
    {"automatic": False, "limits": []},
    {"automatic": False, "limits": []},
]


async def test_import_runs_once(tmp_path: Path) -> None:
    store = ConfigStore(tmp_path / "config.json")
    assert await import_legacy(store, LEGACY_04) == 2
    assert await import_legacy(store, LEGACY_04) == 0
    backup = json.loads((tmp_path / "imported-0.4.json").read_text())
    assert backup["providerInstancesJson"] == LEGACY_04["providerInstancesJson"]
    assert stat.S_IMODE((tmp_path / "imported-0.4.json").stat().st_mode) == 0o600
    assert stat.S_IMODE((tmp_path / "config.json").stat().st_mode) == 0o600
    assert [a["id"] for a in store.load()["accounts"]] == ["b", "a"]


async def test_import_of_03_entries_keeps_top_bar_account(tmp_path: Path) -> None:
    store = ConfigStore(tmp_path / "config.json")
    await import_legacy(store, LEGACY_03)
    assert [a["topBar"] for a in store.load()["accounts"]] == EXPECTED_03_TOP_BAR


async def test_import_carries_the_settings_and_clamps_them(tmp_path: Path) -> None:
    store = ConfigStore(tmp_path / "config.json")
    source = copy.deepcopy(LEGACY_04)
    source.update({"refreshIntervalSeconds": 900, "notificationsEnabled": False, "diagnosticsJournal": True})
    await import_legacy(store, source)
    config = store.load()
    assert config["refreshIntervalSeconds"] == 900
    assert config["alertsEnabled"] is False
    assert config["alertStepPercent"] == 10
    assert config["journalDiagnostics"] is True


def test_missing_config_gives_the_defaults(tmp_path: Path) -> None:
    config = ConfigStore(tmp_path / "config.json").load()
    assert config == {
        "schema": 1,
        "accounts": [],
        "refreshIntervalSeconds": 300,
        "alertsEnabled": True,
        "alertStepPercent": DEFAULT_STEP_PERCENT,
        "journalDiagnostics": False,
    }
    assert DEFAULT_STEP_PERCENT == 10


def test_corrupt_config_is_kept_aside(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text("{")
    assert ConfigStore(tmp_path / "config.json").load()["accounts"] == []
    assert (tmp_path / "config.json.broken").exists()
    assert not (tmp_path / "config.json").exists()


async def test_save_is_private_and_load_round_trips(tmp_path: Path) -> None:
    store = ConfigStore(tmp_path / "sub" / "config.json")
    config = store.load()
    config["accounts"] = [new_provider("codex", "codex-cli", "~/.codex")]
    await store.save(config)
    assert stat.S_IMODE((tmp_path / "sub").stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "sub" / "config.json").stat().st_mode) == 0o600
    assert store.load() == config
