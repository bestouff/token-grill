export type ProviderKind = 'codex' | 'claude' | 'kiro' | 'antigravity' | 'copilot' | 'opencode-go' | 'deepseek' | 'kimi' | 'cursor';
export type AccentColor = 'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'slate';
// A palette name, or a colour the user picked as #rrggbb.
export type AccentValue = AccentColor | `#${string}`;
// The app whose sign-in an account reads.
export type AccountApp = 'codex-cli' | 'claude-code' | 'kiro-cli' | 'antigravity' | 'opencode' | 'github-cli' | 'copilot-cli' | 'keyring' | 'claude-settings' | 'kimi-cli' | 'cursor' | 'cursor-agent';
export type PanelPercentageMode = 'remaining' | 'used';
export type PanelDisplayStyle = 'text' | 'ring' | 'bar';
type ConnectionState = 'unknown' | 'ready' | 'local' | 'stale' | 'error' | 'disabled';
export type CanonicalQuotaWindow = 'five-hour' | 'weekly' | 'monthly' | 'other';
export type ProviderErrorCode =
    | 'auth-missing'
    | 'auth-expired'
    | 'auth-invalid'
    | 'unsupported-account'
    | 'dependency'
    | 'permission'
    | 'offline'
    | 'timeout'
    | 'rate-limited'
    | 'http'
    | 'response-shape'
    | 'local-history'
    | 'internal';
type RefreshPhase = 'idle' | 'queued' | 'fetching-limits' | 'fetching-reset-credits' | 'scanning-history';
type RefreshOutcome = 'changed' | 'unchanged' | 'partial' | 'failed';
type RefreshSource = 'limits' | 'reset-credits' | 'history';
type SourceResult = 'success' | 'failed';
type Recovery = 'retry' | 'reauthenticate' | 'edit-provider' | 'none';
export type PaceLevel = 'high' | 'on-track' | 'low';
type AlertKind = 'milestone' | 'low-balance' | 'test';

// What the service reports for a failure; messageId names the text in the service's catalog.
export interface ErrorInfo {
    code: ProviderErrorCode;
    messageId: string;
    params: Record<string, string>;
    recovery: Recovery;
}

export interface PaceState {
    state: PaceLevel;
    runsOutAt: number | null;
}

// What the top bar shows for an account: the most pressing limit, or the ticked ones.
export interface TopBarSelection {
    automatic: boolean;
    limits: string[];
}

export interface Balance {
    amount: number;
    currency: string;
}

export interface ProviderInstance {
    schemaVersion: 2;
    id: string;
    kind: ProviderKind;
    app: AccountApp;
    displayName: string;
    accent: AccentValue;
    enabled: boolean;
    sortOrder: number;
    accountHome: string;
    authFileOverride: string | null;
    sessionsDirectoryOverride: string | null;
    liveUsageEnabled: boolean;
    localHistoryEnabled: boolean;
    topBar: TopBarSelection;
    lowBalance: number | null;
    // Whether the popup and the top bar show how fast the limits are used.
    showPace: boolean;
}

// A new account as Preferences send it to the service, which fills in the rest as 0.4.1 newProvider() did.
// A DeepSeek account that keeps its key in the keyring carries the pasted key, which the service stores first.
export type AccountDraft = Pick<ProviderInstance, 'kind' | 'app' | 'accountHome' | 'displayName'> & {apiKey?: string};

type CandidateStatus = 'ready' | 'already-added' | 'nothing-to-track' | 'uses-other-app';

// An account that could be added from an app, as the service's Discover finds it.
export interface Candidate {
    // Null for an OpenCode key that reaches no service Token Grill tracks.
    kind: ProviderKind | null;
    app: AccountApp;
    accountHome: string;
    label: string;
    status: CandidateStatus;
    // The id of an account already added on the same plan.
    duplicateOf: string | null;
}

export interface UsageWindow {
    id: string;
    canonicalWindow: CanonicalQuotaWindow;
    label: string;
    used: number | null;
    limit: number | null;
    percent: number | null;
    resetAt: number | null;
    // The length of the window when the service reports it; usage pace needs it.
    durationSeconds: number | null;
    unit: 'credits' | null;
}

// A window of a snapshot, as the service sends it in the popup order.
export interface SnapshotWindow extends UsageWindow {
    // The name of the limit in the top-bar selection.
    key: string;
    pace: PaceState | null;
}

type HistoryState = 'unsupported' | 'off' | 'waiting' | 'updating' | 'failed' | 'ready';

export interface HistoryMetrics {
    state: HistoryState;
    todayTokens: number;
    monthTokens: number;
    // null when no model in the period has a known price.
    monthCost: number | null;
}

interface LimitResetCredit {
    title: string | null;
    expiresAt: number | null;
}

export interface LimitResetCreditSummary {
    availableCount: number;
    credits: LimitResetCredit[];
    fetchedAt: number;
    stale: boolean;
    error: ErrorInfo | null;
}

interface TokenTotals {
    input: number;
    output: number;
    cachedInput: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
}

export interface ProviderSnapshot {
    providerId: string;
    state: ConnectionState;
    lastUpdated: number | null;
    errorInfo: ErrorInfo | null;
    plan: string | null;
    account: string | null;
    windows: SnapshotWindow[];
    balance: Balance | null;
    totals: TokenTotals;
    todayTotals: TokenTotals;
    monthTotals: TokenTotals;
    todayCost: number | null;
    monthCost: number | null;
    quotaFetchedAt: number | null;
    localHistoryUpdatedAt: number | null;
    resetCredits: LimitResetCreditSummary | null;
    // The account pace of the shown limits.
    pace: PaceState | null;
    // The keys of the limits the top bar shows, with Pick Automatically resolved.
    shownLimits: string[];
    history: HistoryMetrics;
    // Whether the CLI signs this account in without a variable that points it at the account home.
    homeIsDefault: boolean;
}

export interface ProviderRuntimeState {
    phase: RefreshPhase;
    outcome: RefreshOutcome | null;
    completedAt: number | null;
    sources: Record<RefreshSource, SourceResult | null>;
}

export interface Settings {
    refreshIntervalSeconds: number;
    alertsEnabled: boolean;
    alertStepPercent: number;
    journalDiagnostics: boolean;
}

export interface ServiceState {
    schema: 1;
    apiVersion: number;
    serviceVersion: string;
    paused: boolean;
    settings: Settings;
    accounts: ProviderInstance[];
    snapshots: Record<string, ProviderSnapshot>;
    runtime: Record<string, ProviderRuntimeState>;
}

// The reply of ImportAccounts. `refused` is true when the service neither took the values nor holds them.
export interface ImportResult {
    imported: number;
    refused: boolean;
}

export interface Alert {
    schema: 1;
    kind: AlertKind;
    accountId: string;
    window: UsageWindow | null;
    fraction: number | null;
    balance: Balance | null;
    lowBalance: number | null;
    at: number;
}

export const BALANCE_KEY = 'balance';

export const ACCENTS: AccentColor[] = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate'];
