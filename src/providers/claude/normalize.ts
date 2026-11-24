import {clampFraction, isRecord, numberAt, recordAt, stringAt, toEpochMs} from '../../core/json.js';
import type {CanonicalQuotaWindow, UsageWindow} from '../../core/types.js';
import {FIVE_HOURS, WEEK, windowLabel} from '../windows.js';

// The key names give the length of each window.
const LEGACY_WINDOWS: Array<[string, CanonicalQuotaWindow, number]> = [
    ['five_hour', 'five-hour', FIVE_HOURS],
    ['seven_day', 'weekly', WEEK],
    ['seven_day_opus', 'other', WEEK],
    ['seven_day_sonnet', 'other', WEEK],
];

const LIMIT_GROUPS: Record<string, [CanonicalQuotaWindow, number]> = {
    session: ['five-hour', FIVE_HOURS],
    weekly: ['weekly', WEEK],
};

function scopeName(scope: Record<string, unknown> | null): string | null {
    if (!scope)
        return null;
    const model = recordAt(scope, 'model');
    const name = model ? stringAt(model, 'display_name') ?? stringAt(model, 'id') : null;
    return [name, stringAt(scope, 'surface')].filter(Boolean).join(' · ') || null;
}

// Claude reports utilization in percentage points (0-100), including
// fractional values: 1 means 1% used, not a fully consumed ratio.
function makeWindow(id: string, canonicalWindow: CanonicalQuotaWindow, label: string, percentagePoints: number, reset: unknown, durationSeconds: number): UsageWindow {
    return {
        id,
        canonicalWindow,
        label,
        used: null,
        limit: null,
        percent: clampFraction(percentagePoints / 100),
        resetAt: toEpochMs(reset),
        durationSeconds,
        unit: null,
    };
}

function modelOf(scope: string): string {
    const [model = ''] = scope.split(' · ');
    return model.toLowerCase();
}

// Model-scoped limits in the `limits` array are separate limits that Claude
// shows to the user, so each one is kept. Unscoped limits only fill the
// windows the legacy keys left out, because otherwise they repeat them.
function limitWindows(limits: unknown, legacyKeys: Set<string>, present: Set<CanonicalQuotaWindow>): UsageWindow[] {
    if (!Array.isArray(limits))
        return [];
    interface Entry {canonicalWindow: CanonicalQuotaWindow; scope: string | null; window: UsageWindow}
    const entries: Entry[] = [];
    for (const item of limits.filter(isRecord)) {
        const percent = numberAt(item, 'percent');
        const group = stringAt(item, 'group') ?? '';
        const groupWindow = LIMIT_GROUPS[group];
        if (percent === null || !groupWindow)
            continue;
        const [canonicalWindow, seconds] = groupWindow;
        const scope = scopeName(recordAt(item, 'scope'));
        if (scope && legacyKeys.has(`seven_day_${modelOf(scope)}`))
            continue;
        const kind = stringAt(item, 'kind') ?? group;
        const base = windowLabel(canonicalWindow, kind);
        const id = scope ? `limits:${kind}:${scope}` : `limits:${kind}`;
        const window = makeWindow(id, canonicalWindow, scope ? `${base} · ${scope}` : base, percent, item.resets_at, seconds);
        entries.push({canonicalWindow, scope, window});
    }
    const fills = new Map<CanonicalQuotaWindow, Entry>();
    for (const entry of entries) {
        const existing = fills.get(entry.canonicalWindow);
        if (present.has(entry.canonicalWindow) || (existing && (!existing.scope || entry.scope)))
            continue;
        fills.set(entry.canonicalWindow, entry);
    }
    const used = new Set(fills.values());
    const scoped = entries
        .filter(entry => entry.scope && !used.has(entry))
        .map(entry => ({...entry.window, canonicalWindow: 'other' as const}));
    return [...[...fills.values()].map(entry => entry.window), ...scoped];
}

export function normalizeClaudeUsage(payload: unknown): UsageWindow[] {
    if (!isRecord(payload))
        return [];
    const windows: UsageWindow[] = [];
    const legacyKeys: string[] = [];
    for (const [key, canonicalWindow, seconds] of LEGACY_WINDOWS) {
        const item = recordAt(payload, key);
        const utilization = item ? numberAt(item, 'utilization') : null;
        if (item && utilization !== null) {
            legacyKeys.push(key);
            windows.push(makeWindow(key, canonicalWindow, windowLabel(canonicalWindow, key.replaceAll('_', ' ')), utilization, item.resets_at, seconds));
        }
    }
    windows.push(...limitWindows(payload.limits, new Set(legacyKeys), new Set(windows.map(window => window.canonicalWindow))));
    return windows;
}
