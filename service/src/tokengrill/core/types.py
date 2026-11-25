"""Payload types shared with the extension; keys match src/core/types.ts."""

from typing import Literal, TypedDict

ProviderKind = Literal["codex", "claude", "kiro", "antigravity", "copilot", "opencode-go", "deepseek", "kimi", "cursor"]
AccentColor = Literal["blue", "teal", "green", "yellow", "orange", "red", "pink", "purple", "slate"]
# A palette name, or a colour the user picked as #rrggbb.
AccentValue = str
AccountApp = Literal[
    "codex-cli",
    "claude-code",
    "kiro-cli",
    "antigravity",
    "opencode",
    "github-cli",
    "copilot-cli",
    "keyring",
    "claude-settings",
    "kimi-cli",
    "cursor",
    "cursor-agent",
]
QuotaWindowPreference = Literal["automatic", "five-hour", "weekly", "monthly"]
PanelPercentageMode = Literal["remaining", "used"]
PanelDisplayStyle = Literal["text", "ring", "bar"]
ConnectionState = Literal["unknown", "ready", "local", "stale", "error", "disabled"]
CanonicalQuotaWindow = Literal["five-hour", "weekly", "monthly", "other"]
ErrorCode = Literal[
    "auth-missing",
    "auth-expired",
    "auth-invalid",
    "unsupported-account",
    "dependency",
    "permission",
    "offline",
    "timeout",
    "rate-limited",
    "http",
    "response-shape",
    "local-history",
]
Recovery = Literal["retry", "reauthenticate", "edit-provider", "none"]
RefreshPhase = Literal["idle", "queued", "fetching-limits", "fetching-reset-credits", "scanning-history"]
RefreshOutcome = Literal["changed", "unchanged", "partial", "failed"]
RefreshSource = Literal["limits", "reset-credits", "history"]
SourceResult = Literal["success", "failed"]
PaceLevel = Literal["high", "on-track", "low"]
AlertKind = Literal["milestone", "low-balance", "test"]


class ErrorInfo(TypedDict):
    code: ErrorCode
    messageId: str
    params: dict[str, str]
    recovery: Recovery


class PaceState(TypedDict):
    state: PaceLevel
    runsOutAt: int | None


class TopBarSelection(TypedDict):
    automatic: bool
    limits: list[str]


class Balance(TypedDict):
    amount: float
    currency: str


class ProviderInstance(TypedDict):
    schemaVersion: Literal[2]
    id: str
    kind: ProviderKind
    app: AccountApp
    displayName: str
    accent: AccentValue
    enabled: bool
    sortOrder: int
    accountHome: str
    authFileOverride: str | None
    sessionsDirectoryOverride: str | None
    liveUsageEnabled: bool
    localHistoryEnabled: bool
    topBar: TopBarSelection
    lowBalance: float | None
    # Whether the popup and the top bar show how fast the limits are used.
    showPace: bool


class UsageWindow(TypedDict):
    id: str
    canonicalWindow: CanonicalQuotaWindow
    label: str
    used: float | None
    limit: float | None
    percent: float | None
    resetAt: int | None
    # The length of the window when the service reports it; usage pace needs it.
    durationSeconds: int | None
    unit: Literal["credits"] | None
    pace: PaceState | None


class LimitResetCredit(TypedDict):
    title: str | None
    expiresAt: int | None


class LimitResetCreditSummary(TypedDict):
    availableCount: int
    credits: list[LimitResetCredit]
    fetchedAt: int
    stale: bool
    error: ErrorInfo | None


class TokenTotals(TypedDict):
    input: int
    output: int
    cachedInput: int
    cacheWrite: int
    reasoning: int
    total: int


class ProviderSnapshot(TypedDict):
    providerId: str
    state: ConnectionState
    lastUpdated: int | None
    errorInfo: ErrorInfo | None
    plan: str | None
    account: str | None
    windows: list[UsageWindow]
    balance: Balance | None
    totals: TokenTotals
    todayTotals: TokenTotals
    monthTotals: TokenTotals
    todayCost: float | None
    monthCost: float | None
    quotaFetchedAt: int | None
    localHistoryUpdatedAt: int | None
    resetCredits: LimitResetCreditSummary | None
    # The account pace of the shown limits.
    pace: PaceState | None


class ProviderRuntimeState(TypedDict):
    phase: RefreshPhase
    outcome: RefreshOutcome | None
    completedAt: int | None
    sources: dict[RefreshSource, SourceResult | None]


class UsageEvent(TypedDict):
    capturedAt: int
    model: str | None
    totals: TokenTotals


class AggregateBucket(TypedDict):
    providerId: str
    date: str
    model: str
    totals: TokenTotals


class FileCheckpoint(TypedDict):
    providerId: str
    path: str
    size: int
    mtime: int
    offset: int
    parserVersion: int


class ProviderPaths(TypedDict):
    authFile: str
    historyDirectories: list[str]


class Settings(TypedDict):
    refreshIntervalSeconds: int
    alertsEnabled: bool
    alertStepPercent: int
    journalDiagnostics: bool


class ServiceState(TypedDict):
    schema: Literal[1]
    apiVersion: int
    serviceVersion: str
    paused: bool
    settings: Settings
    accounts: list[ProviderInstance]
    snapshots: dict[str, ProviderSnapshot]
    runtime: dict[str, ProviderRuntimeState]


class Alert(TypedDict):
    schema: Literal[1]
    kind: AlertKind
    accountId: str
    window: UsageWindow | None
    fraction: float | None
    balance: Balance | None
    lowBalance: float | None
    at: int


EMPTY_TOTALS: TokenTotals = {
    "input": 0,
    "output": 0,
    "cachedInput": 0,
    "cacheWrite": 0,
    "reasoning": 0,
    "total": 0,
}

BALANCE_KEY = "balance"

ACCENTS: list[AccentColor] = ["blue", "teal", "green", "yellow", "orange", "red", "pink", "purple", "slate"]


def empty_snapshot(provider_id: str) -> ProviderSnapshot:
    return {
        "providerId": provider_id,
        "state": "unknown",
        "lastUpdated": None,
        "errorInfo": None,
        "plan": None,
        "account": None,
        "windows": [],
        "balance": None,
        "totals": {**EMPTY_TOTALS},
        "todayTotals": {**EMPTY_TOTALS},
        "monthTotals": {**EMPTY_TOTALS},
        "todayCost": None,
        "monthCost": None,
        "quotaFetchedAt": None,
        "localHistoryUpdatedAt": None,
        "resetCredits": None,
        "pace": None,
    }
