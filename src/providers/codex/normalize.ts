import type {CanonicalQuotaWindow, UsageWindow} from '../../core/types.js';

export interface CodexUsageResult {
    windows: UsageWindow[];
    plan: string | null;
}

function numberAt(value: unknown, keys: string[]): number | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const object = value as Record<string, unknown>;
    for (const key of keys) {
        const candidate = object[key];
        if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    }
    return null;
}

function canonicalFor(seconds: number | null, label: string): CanonicalQuotaWindow {
    const text = label.toLowerCase();
    // Duration is authoritative for the observed Codex response.  The API's
    // primary/secondary names describe ordering, not the actual quota window.
    if ((seconds !== null && Math.abs(seconds - 5 * 60 * 60) <= 2 * 60 * 60) || /five.?hour|5.?hour|session/.test(text)) return 'five-hour';
    if ((seconds !== null && Math.abs(seconds - 7 * 24 * 60 * 60) <= 24 * 60 * 60) || /weekly|week|7.?day/.test(text)) return 'weekly';
    return 'other';
}

function friendlyLabel(canonical: CanonicalQuotaWindow, fallback: string): string {
    if (canonical === 'five-hour') return 'Five-hour';
    if (canonical === 'weekly') return 'Weekly';
    return fallback || 'Usage limit';
}

function normalizeWindow(value: unknown, fallbackLabel: string, index: number): UsageWindow | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const object = value as Record<string, unknown>;
    const seconds = numberAt(object, ['limit_window_seconds', 'window_seconds', 'duration_seconds']);
    const label = typeof object.window === 'string' ? object.window : typeof object.duration === 'string' ? object.duration : fallbackLabel;
    const used = numberAt(object, ['used', 'used_tokens', 'tokens_used', 'total_tokens_used']);
    const limit = numberAt(object, ['limit', 'token_limit', 'total_tokens_limit', 'quota', 'max']);
    // Codex reports percentage-named fields in percentage points (0-100),
    // including fractional values such as 0.4%.  In particular, a value of 1
    // means 1% used, not a fully consumed 0-1 ratio.
    const percentagePoints = numberAt(object, ['used_percent', 'percent_used', 'percent', 'percentage', 'usage_percent']);
    const utilization = numberAt(object, ['utilization']);
    const percent = percentagePoints !== null ? percentagePoints / 100 :
        utilization !== null ? (utilization > 1 ? utilization / 100 : utilization) :
        used !== null && limit !== null && limit > 0 ? used / limit : null;
    const resetAtRaw = numberAt(object, ['reset_at', 'resetAt', 'reset_time']);
    const resetAfterSeconds = numberAt(object, ['reset_after_seconds', 'resetAfterSeconds']);
    const resetAt = resetAtRaw === null ? null : resetAtRaw < 10000000000 ? resetAtRaw * 1000 : resetAtRaw;
    if (percent === null && used === null && limit === null) return null;
    const canonicalWindow = canonicalFor(seconds, label);
    return {
        id: `${canonicalWindow}-${index}`,
        canonicalWindow,
        label: friendlyLabel(canonicalWindow, label),
        used,
        limit,
        percent: percent === null ? null : Math.max(0, Math.min(1, percent)),
        resetAt,
        resetAfterSeconds,
        windowSeconds: seconds,
    };
}

export function normalizeCodexUsage(payload: unknown): CodexUsageResult {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {windows: [], plan: null};
    const object = payload as Record<string, unknown>;
    const candidates: Array<[unknown, string]> = [];
    const addSection = (section: unknown, prefix: string): void => {
        if (!section || typeof section !== 'object' || Array.isArray(section)) return;
        const value = section as Record<string, unknown>;
        candidates.push([value.primary_window, `${prefix} primary`]);
        candidates.push([value.secondary_window, `${prefix} secondary`]);
        if (Array.isArray(value.windows)) for (const item of value.windows) candidates.push([item, `${prefix} window`]);
    };
    addSection(object.rate_limit, 'Rate limit');
    if (Array.isArray(object.additional_rate_limits)) {
        object.additional_rate_limits.forEach((item, index) => addSection((item as Record<string, unknown>)?.rate_limit ?? item, `Additional ${index + 1}`));
    } else if (object.additional_rate_limits && typeof object.additional_rate_limits === 'object') {
        Object.entries(object.additional_rate_limits as Record<string, unknown>).forEach(([key, item]) => addSection((item as Record<string, unknown>)?.rate_limit ?? item, key));
    }
    const windows: UsageWindow[] = [];
    const seen = new Set<string>();
    for (const [candidate, label] of candidates) {
        const window = normalizeWindow(candidate, label, windows.length);
        if (!window) continue;
        const key = `${window.canonicalWindow}:${window.percent}:${window.resetAt}:${window.windowSeconds}`;
        if (seen.has(key)) continue;
        seen.add(key);
        windows.push(window);
    }
    return {windows, plan: typeof object.plan_type === 'string' ? object.plan_type : null};
}
