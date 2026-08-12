export type ProviderKind = 'codex' | 'claude' | 'kiro';
export type AccentColor = 'blue' | 'cyan' | 'green' | 'amber' | 'orange' | 'red' | 'purple' | 'pink';
export type QuotaWindowPreference = 'automatic' | 'five-hour' | 'weekly' | 'monthly';
export type PanelPercentageMode = 'remaining' | 'used';
export type PanelDisplayStyle = 'text' | 'ring' | 'bar';
export type ConnectionState = 'unknown' | 'ready' | 'local' | 'stale' | 'error' | 'disabled';
export type CanonicalQuotaWindow = 'five-hour' | 'weekly' | 'monthly' | 'other';
export type ProviderErrorCode = 'auth-missing' | 'auth-expired' | 'auth-invalid' | 'dependency' | 'permission' | 'offline' | 'timeout' | 'rate-limited' | 'http' | 'response-shape' | 'local-history';
export type RefreshTrigger = 'startup' | 'scheduled' | 'manual-provider' | 'manual-all' | 'unlock' | 'network-reconnected';
export type RefreshPhase = 'idle' | 'queued' | 'fetching-limits' | 'fetching-reset-credits' | 'scanning-history' | 'success' | 'partial' | 'failed';
export type RefreshOutcome = 'changed' | 'unchanged' | 'partial' | 'failed' | null;

export interface RefreshRequestResult {
    jobIds: string[];
    acceptedProviderIds: string[];
    coalescedProviderIds: string[];
    rejectedProviderIds: string[];
}

export interface ProviderErrorInfo {
    code: ProviderErrorCode;
    message: string;
    recovery: 'retry' | 'reauthenticate' | 'edit-provider' | 'none';
    occurredAt: number;
    retryAt: number | null;
}

export interface ProviderInstance {
    schemaVersion: 2;
    id: string;
    kind: ProviderKind;
    displayName: string;
    accent: AccentColor;
    enabled: boolean;
    showInPanel: boolean;
    sortOrder: number;
    accountHome: string;
    authFileOverride: string | null;
    sessionsDirectoryOverride: string | null;
    liveUsageEnabled: boolean;
    localHistoryEnabled: boolean;
    panelWindowPreference: QuotaWindowPreference;
}

export interface UsageWindow {
    id: string;
    canonicalWindow: CanonicalQuotaWindow;
    label: string;
    used: number | null;
    limit: number | null;
    percent: number | null;
    resetAt: number | null;
    resetAfterSeconds: number | null;
    windowSeconds: number | null;
    unit?: string | null;
}

export type ResetCreditStatus = 'available' | 'redeemed' | 'expired' | 'unknown';

export interface LimitResetCredit {
    resetType: string | null;
    title: string | null;
    status: ResetCreditStatus;
    grantedAt: number | null;
    expiresAt: number | null;
}

export interface LimitResetCreditSummary {
    supported: boolean;
    availableCount: number | null;
    totalEarnedCount: number | null;
    nextExpiresAt: number | null;
    credits: LimitResetCredit[];
    fetchedAt: number | null;
    stale: boolean;
    error: ProviderErrorInfo | null;
}

export interface TokenTotals {
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
    error: string | null;
    errorInfo: ProviderErrorInfo | null;
    plan: string | null;
    windows: UsageWindow[];
    totals: TokenTotals;
    todayTotals: TokenTotals;
    monthTotals: TokenTotals;
    todayCost: number | null;
    monthCost: number | null;
    indexedFiles: number;
    indexedBytes: number;
    quotaFetchedAt: number | null;
    quotaDataChangedAt: number | null;
    localHistoryUpdatedAt: number | null;
    resetCreditsFetchedAt: number | null;
    resetCredits: LimitResetCreditSummary | null;
}

export interface SourceRefreshState {
    enabled: boolean;
    phase: 'idle' | 'queued' | 'running' | 'success' | 'failed';
    startedAt: number | null;
    completedAt: number | null;
    error: ProviderErrorInfo | null;
}

export interface ProviderRefreshState {
    jobId: string | null;
    providerId: string;
    trigger: RefreshTrigger | null;
    phase: RefreshPhase;
    requestedAt: number | null;
    startedAt: number | null;
    completedAt: number | null;
    lastAttemptAt: number | null;
    lastSuccessfulRefresh: number | null;
    lastDataChangeAt: number | null;
    outcome: RefreshOutcome;
    limits: SourceRefreshState;
    resetCredits: SourceRefreshState;
    localHistory: SourceRefreshState;
}

export interface ProviderRuntimeState {
    providerId: string;
    snapshot: ProviderSnapshot | null;
    refresh: ProviderRefreshState;
    error: ProviderErrorInfo | null;
}

export interface UsageEvent {
    providerId: string;
    source: string;
    eventKey: string;
    capturedAt: number;
    model: string | null;
    totals: TokenTotals;
}

export interface AggregateBucket {
    providerId: string;
    date: string;
    model: string;
    totals: TokenTotals;
    events: number;
    sourceBytes: Record<string, number>;
}

export interface FileCheckpoint {
    providerId: string;
    path: string;
    size: number;
    mtime: number;
    offset: number;
    parserVersion: number;
}

export interface ProviderPaths {
    authFile: string;
    sessionsDirectory: string;
    archivedSessionsDirectory: string;
    configFile: string;
}

export const EMPTY_TOTALS: TokenTotals = {
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
};

export const ACCENTS: AccentColor[] = ['blue', 'cyan', 'green', 'amber', 'orange', 'red', 'purple', 'pink'];

export function emptySnapshot(providerId: string): ProviderSnapshot {
    return {
        providerId,
        state: 'unknown',
        lastUpdated: null,
        error: null,
        errorInfo: null,
        plan: null,
        windows: [],
        totals: {...EMPTY_TOTALS},
        todayTotals: {...EMPTY_TOTALS},
        monthTotals: {...EMPTY_TOTALS},
        todayCost: null,
        monthCost: null,
        indexedFiles: 0,
        indexedBytes: 0,
        quotaFetchedAt: null,
        quotaDataChangedAt: null,
        localHistoryUpdatedAt: null,
        resetCreditsFetchedAt: null,
        resetCredits: null,
    };
}
