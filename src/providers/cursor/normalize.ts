// Cursor's dashboard service is undocumented. These readers keep only the
// fields seen in real `GetCurrentPeriodUsage` and `GetPlanInfo` responses.
import {clampFraction, isRecord, numberAt, recordAt, stringAt, toEpochMs} from '../../core/json.js';
import type {CanonicalQuotaWindow, UsageWindow} from '../../core/types.js';
import {claimType} from '../windows.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The total and the two pools of Cursor's usage page: Cursor's own models,
// which Auto uses, and the other models, picked by name.
const POOLS: Array<[key: string, id: string, name: string]> = [
    ['totalPercentUsed', 'total', 'Total'],
    ['autoPercentUsed', 'cursor-models', 'Cursor Models'],
    ['apiPercentUsed', 'other-models', 'Other Models'],
];

// Cursor sends epoch milliseconds as decimal strings.
function epochMs(value: unknown): number | null {
    return toEpochMs(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
}

// All pools reset with the billing cycle, so its length gives their type.
function cycleType(start: number | null, end: number | null): CanonicalQuotaWindow {
    if (start === null || end === null)
        return 'other';
    const days = (end - start) / DAY_MS;
    if (days >= 6 && days <= 8)
        return 'weekly';
    return days >= 27 && days <= 32 ? 'monthly' : 'other';
}

export function normalizeCursorUsage(payload: unknown): UsageWindow[] {
    const usage = isRecord(payload) ? recordAt(payload, 'planUsage') : null;
    if (!isRecord(payload) || !usage)
        return [];
    const start = epochMs(payload.billingCycleStart);
    const resetAt = epochMs(payload.billingCycleEnd);
    const cycle = cycleType(start, resetAt);
    const durationSeconds = start !== null && resetAt !== null && resetAt > start ? (resetAt - start) / 1000 : null;
    const claimed = new Set<CanonicalQuotaWindow>();
    return POOLS.flatMap(([key, id, name]) => {
        const percent = numberAt(usage, key);
        if (percent === null)
            return [];
        // Cursor reports percentage points, 0 to 100.
        return [{id, ...claimType(claimed, cycle, name), used: null, limit: null, percent: clampFraction(percent / 100), resetAt, durationSeconds, unit: null}];
    });
}

// Cursor stores either a plain JWT or an encrypted value with a prefix of its own.
export function isJwtLike(token: string): boolean {
    return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
}

export function normalizeCursorPlan(payload: unknown): string | null {
    const info = isRecord(payload) ? recordAt(payload, 'planInfo') : null;
    return info ? stringAt(info, 'planName') : null;
}
