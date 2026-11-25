"""The account list and settings of the service, and the one-time import from 0.4.x GSettings."""

import json
import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal, TypedDict

from tokengrill.core.json_util import is_record
from tokengrill.core.order import ordered_providers
from tokengrill.core.paths import expand_path
from tokengrill.core.types import (
    ACCENTS,
    AccentColor,
    AccentValue,
    AccountApp,
    ProviderInstance,
    ProviderKind,
    QuotaWindowPreference,
    Settings,
    TopBarSelection,
)
from tokengrill.storage.atomic_json import MAX_STATE_BYTES, SerialWriter, read_json

# The settings layout version; the entries themselves keep format 2 so 0.3.x can still read them.
CONFIGURATION_VERSION = 3
ENTRY_SCHEMA_VERSION: Final = 2
_MAX_LIMIT_KEY_LENGTH = 64
_QUOTA_WINDOW_PREFERENCES: list[QuotaWindowPreference] = ["automatic", "five-hour", "weekly", "monthly"]
_CUSTOM_ACCENT = re.compile(r"#[0-9a-fA-F]{6}")
# Accent names used before the switch to the GNOME palette.
_LEGACY_ACCENTS: dict[str, AccentColor] = {"cyan": "teal", "amber": "yellow"}

# schemas/org.gnome.shell.extensions.tokengrill.gschema.xml of 0.4.1
DEFAULT_REFRESH_SECONDS = 300
_REFRESH_RANGE = (60, 3600)
DEFAULT_STEP_PERCENT = 10
_STEP_RANGE = (5, 50)

_LOG = logging.getLogger("tokengrill.config")


@dataclass(frozen=True)
class _Metadata:
    label: str
    default_accent: AccentColor
    quota_windows: tuple[str, ...]
    default_quota_window: QuotaWindowPreference
    local_history: bool
    # The apps an account can be read from; the first is the default.
    apps: tuple[AccountApp, ...]


_METADATA: dict[ProviderKind, _Metadata] = {
    "codex": _Metadata("Codex", "green", ("five-hour", "weekly"), "automatic", True, ("codex-cli", "opencode")),
    "claude": _Metadata("Claude", "orange", ("five-hour", "weekly"), "automatic", True, ("claude-code", "opencode")),
    "kiro": _Metadata("Kiro", "purple", ("monthly",), "monthly", False, ("kiro-cli",)),
    "antigravity": _Metadata("Antigravity", "teal", ("five-hour", "weekly"), "automatic", False, ("antigravity",)),
    "copilot": _Metadata("Copilot", "slate", ("monthly",), "monthly", False, ("github-cli", "copilot-cli", "opencode")),
    "opencode-go": _Metadata(
        "OpenCode Go", "yellow", ("five-hour", "weekly", "monthly"), "automatic", False, ("opencode",)
    ),
    "deepseek": _Metadata("DeepSeek", "blue", (), "automatic", False, ("keyring", "opencode", "claude-settings")),
    "kimi": _Metadata(
        "Kimi Code", "pink", ("five-hour", "weekly", "monthly"), "automatic", False, ("kimi-cli", "opencode")
    ),
    "cursor": _Metadata("Cursor", "slate", ("monthly",), "automatic", False, ("cursor", "cursor-agent")),
}


class LegacySettings(TypedDict):
    """The GSettings values of 0.4.1 that the extension hands over once."""

    providerInstancesJson: str
    configurationVersion: int
    activeProviderId: str
    refreshIntervalSeconds: int
    notificationsEnabled: bool
    notificationStepPercent: int
    diagnosticsJournal: bool


class Config(Settings):
    schema: Literal[1]
    accounts: list[ProviderInstance]


def default_settings() -> Settings:
    return {
        "refreshIntervalSeconds": DEFAULT_REFRESH_SECONDS,
        "alertsEnabled": True,
        "alertStepPercent": DEFAULT_STEP_PERCENT,
        "journalDiagnostics": False,
    }


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _truthy(value: object) -> bool:
    """JavaScript truthiness: an empty object or array still counts."""
    return value is not None and value is not False and value != 0 and value != ""


def _is_valid_path(value: str) -> bool:
    try:
        expand_path(value)
    except ValueError:
        return False
    return True


def _optional_path(value: object) -> str | None:
    return value if isinstance(value, str) and value and _is_valid_path(value) else None


def _normalize_accent(value: object, fallback: AccentColor) -> AccentValue:
    if not isinstance(value, str):
        return fallback
    if value in ACCENTS:
        return value
    if _CUSTOM_ACCENT.fullmatch(value):
        return value.lower()
    return _LEGACY_ACCENTS.get(value, fallback)


def _normalize_top_bar(value: object) -> TopBarSelection:
    if not is_record(value):
        return {"automatic": False, "limits": []}
    keys = value.get("limits")
    limits = [
        key
        for key in (keys if isinstance(keys, list) else [])
        if isinstance(key, str) and 0 < len(key) <= _MAX_LIMIT_KEY_LENGTH
    ]
    return {"automatic": value.get("automatic") is True, "limits": list(dict.fromkeys(limits))}


def _has_top_bar(value: object) -> bool:
    return is_record(value) and _truthy(value.get("topBar"))


def _kind_of(value: object) -> ProviderKind | None:
    return value if isinstance(value, str) and value in _METADATA else None


def normalize_provider(entry: object) -> list[ProviderInstance]:
    """One valid account, or none when the entry is not one 0.4.1 would accept."""
    if not is_record(entry):
        return []
    if entry.get("schemaVersion") not in (1, ENTRY_SCHEMA_VERSION) or isinstance(entry.get("schemaVersion"), bool):
        return []
    kind = _kind_of(entry.get("kind"))
    provider_id = entry.get("id")
    home = entry.get("accountHome")
    if not isinstance(provider_id, str) or kind is None or not isinstance(home, str):
        return []

    metadata = _METADATA[kind]
    # Local history is read from the service's own app; other apps only lend their sign-in.
    app = next((item for item in metadata.apps if item == entry.get("app")), metadata.apps[0])
    # Only a key pasted into the keyring has no home.
    if not _is_valid_path(home) and not (app == "keyring" and home == ""):
        return []
    name = entry.get("displayName")
    display_name = name.strip() if isinstance(name, str) else ""
    sort_order = entry.get("sortOrder")
    low = entry.get("lowBalance")

    return [
        {
            "schemaVersion": ENTRY_SCHEMA_VERSION,
            "id": provider_id,
            "kind": kind,
            "app": app,
            "displayName": display_name or metadata.label,
            "accent": _normalize_accent(entry.get("accent"), metadata.default_accent),
            "enabled": entry.get("enabled") is not False,
            "sortOrder": sort_order if _is_number(sort_order) else 0,  # type: ignore[typeddict-item]
            "accountHome": home,
            "authFileOverride": _optional_path(entry.get("authFileOverride")),
            "sessionsDirectoryOverride": _optional_path(entry.get("sessionsDirectoryOverride")),
            "liveUsageEnabled": entry.get("liveUsageEnabled") is not False,
            "localHistoryEnabled": metadata.local_history
            and app == metadata.apps[0]
            and entry.get("localHistoryEnabled") is True,
            "topBar": _normalize_top_bar(entry.get("topBar")),
            "lowBalance": float(low)
            if isinstance(low, int | float) and not isinstance(low, bool) and low >= 0
            else None,
            "showPace": entry.get("showPace") is True,
        }
    ]


def new_provider(kind: ProviderKind, app: AccountApp, home: str) -> ProviderInstance:
    metadata = _METADATA[kind]
    return {
        "schemaVersion": ENTRY_SCHEMA_VERSION,
        "id": str(uuid.uuid4()),
        "kind": kind,
        "app": app,
        "displayName": metadata.label,
        "accent": metadata.default_accent,
        "enabled": True,
        "sortOrder": 0,
        "accountHome": home,
        "authFileOverride": None,
        "sessionsDirectoryOverride": None,
        "liveUsageEnabled": True,
        "localHistoryEnabled": False,
        "topBar": {"automatic": True, "limits": []},
        "lowBalance": None,
        "showPace": False,
    }


_READ_FIELDS = (
    "kind",
    "app",
    "accountHome",
    "authFileOverride",
    "sessionsDirectoryOverride",
    "liveUsageEnabled",
    "localHistoryEnabled",
)


def needs_refresh(before: ProviderInstance | None, after: ProviderInstance) -> bool:
    """Name, colour, top-bar and warning changes need no new reading; a new account,
    one turned back on, or a change to how it is read does."""
    if before is None or (after["enabled"] and not before["enabled"]):
        return True
    return any(before[field] != after[field] for field in _READ_FIELDS)  # type: ignore[literal-required]


def _stored_entries(legacy: LegacySettings) -> list[Any]:
    try:
        parsed = json.loads(legacy["providerInstancesJson"])
    except ValueError:
        return []
    return parsed if isinstance(parsed, list) else []


def _is_legacy_entry(item: object) -> bool:
    return is_record(item) and item.get("schemaVersion") == 1 and not isinstance(item.get("schemaVersion"), bool)


def _stored_field(item: object, key: str) -> object:
    return item.get(key) if is_record(item) else None


def _legacy_window(item: object, kind: ProviderKind) -> QuotaWindowPreference:
    metadata = _METADATA[kind]
    stored = next((w for w in _QUOTA_WINDOW_PREFERENCES if w == _stored_field(item, "panelWindowPreference")), None)
    if stored is None:
        return metadata.default_quota_window
    # 0.3.x fell back to the most used limit when the service did not report the chosen one.
    if stored != "automatic" and stored not in metadata.quota_windows:
        return metadata.default_quota_window if len(metadata.quota_windows) == 1 else "automatic"
    return stored


def _legacy_top_bar(provider: ProviderInstance, item: object, active_id: str | None) -> TopBarSelection:
    """Before 0.4.0 the top bar showed one account, the active one, with its preferred limit;
    that account keeps that look and the others start hidden."""
    if provider["id"] != active_id:
        return {"automatic": False, "limits": []}
    window = _legacy_window(item, provider["kind"])
    return {"automatic": True, "limits": []} if window == "automatic" else {"automatic": False, "limits": [window]}


def _legacy_active_id(providers: list[ProviderInstance], stored: list[Any], active_id: str) -> str | None:
    """The account 0.3.x showed in the top bar, chosen the way 0.3.x chose it."""
    enabled = [provider for provider in providers if provider["enabled"]]
    chosen = next((p for p in enabled if p["id"] == active_id), None)
    if chosen is None:
        chosen = next(
            (
                p
                for i, p in enumerate(providers)
                if p["enabled"] and _stored_field(stored[i], "showInPanel") is not False
            ),
            None,
        )
    if chosen is None and enabled:
        chosen = enabled[0]
    return chosen["id"] if chosen else None


def migrate_provider_settings(legacy: LegacySettings) -> list[ProviderInstance]:
    """The accounts of a 0.3.x or 0.4.x configuration, in order.

    A malformed value keeps its entries as they are read: migrating it would
    silently drop the ones that fail to normalize.
    """
    stored = _stored_entries(legacy)
    providers = [provider for item in stored for provider in normalize_provider(item)]
    version = legacy["configurationVersion"]
    outdated = version < CONFIGURATION_VERSION or any(_is_legacy_entry(item) for item in stored)
    if not outdated or len(providers) != len(stored):
        return ordered_providers(providers)
    if version < CONFIGURATION_VERSION:
        active_id = _legacy_active_id(providers, stored, legacy["activeProviderId"])
        providers = [
            provider
            if _has_top_bar(stored[index])
            else {**provider, "topBar": _legacy_top_bar(provider, stored[index], active_id)}
            for index, provider in enumerate(providers)
        ]
    return ordered_providers(providers)


def _bounded_int(value: object, bounds: tuple[int, int], default: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and bounds[0] <= value <= bounds[1]:
        return value
    return default


def _settings_from(source: dict[str, Any]) -> Settings:
    defaults = default_settings()
    return {
        "refreshIntervalSeconds": _bounded_int(
            source.get("refreshIntervalSeconds"), _REFRESH_RANGE, defaults["refreshIntervalSeconds"]
        ),
        "alertsEnabled": source["alertsEnabled"] if isinstance(source.get("alertsEnabled"), bool) else True,
        "alertStepPercent": _bounded_int(source.get("alertStepPercent"), _STEP_RANGE, defaults["alertStepPercent"]),
        "journalDiagnostics": source.get("journalDiagnostics") is True,
    }


class ConfigStore:
    """config.json: the accounts and settings, private to the user."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._writer = SerialWriter(path)

    def load(self) -> Config:
        value = read_json(self.path, MAX_STATE_BYTES)
        if not is_record(value):
            if self.path.exists():
                self._keep_aside()
            return {"schema": 1, "accounts": [], **default_settings()}
        accounts = value.get("accounts")
        entries = accounts if isinstance(accounts, list) else []
        return {
            "schema": 1,
            "accounts": ordered_providers([p for entry in entries for p in normalize_provider(entry)]),
            **_settings_from(value),
        }

    def _keep_aside(self) -> None:
        broken = self.path.with_name(f"{self.path.name}.broken")
        try:
            self.path.replace(broken)
        except OSError:
            _LOG.warning("Could not move the unreadable %s aside", self.path, exc_info=True)
            return
        _LOG.warning("Moved the unreadable %s to %s", self.path, broken)

    async def save(self, config: Config) -> None:
        await self._writer.write(config)


async def import_legacy(store: ConfigStore, legacy: LegacySettings) -> int:
    """Takes over the 0.4.x GSettings once; the raw values stay beside config.json for recovery."""
    if store.load()["accounts"]:
        return 0
    backup = SerialWriter(store.path.with_name("imported-0.4.json"))
    await backup.write(legacy)
    accounts = migrate_provider_settings(legacy)
    settings = _settings_from(
        {
            "refreshIntervalSeconds": legacy["refreshIntervalSeconds"],
            "alertsEnabled": legacy["notificationsEnabled"],
            "alertStepPercent": legacy["notificationStepPercent"],
            "journalDiagnostics": legacy["diagnosticsJournal"],
        }
    )
    await store.save({"schema": 1, "accounts": accounts, **settings})
    return len(accounts)
