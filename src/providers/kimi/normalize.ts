// Kimi Code's usage endpoint is undocumented and public descriptions of it
// disagree, so both layouts are read: `usages.limit_*` with used ratios, and a
// `usage` block plus `limits[]` with counts (numbers may be strings).
import {isRecord, recordAt, stringAt, toEpochMs, toNumber} from '../../core/json.js';
import type {CanonicalQuotaWindow, UsageWindow} from '../../core/types.js';
import {claimType, monthBefore, namedLength, windowLabel} from '../windows.js';

// The key names give the length of each window.
const RATIO_WINDOWS: [string, CanonicalQuotaWindow, string, 'five-hour' | 'weekly' | 'month'][] = [
    ['limit_5h', 'five-hour', '', 'five-hour'],
    ['limit_7d', 'weekly', '', 'weekly'],
    ['limit_month_total', 'monthly', '', 'month'],
    ['limit_month_code', 'other', 'Monthly Code', 'month'],
];

const UNIT_SECONDS: Record<string, number> = {MINUTE: 60, HOUR: 3600, DAY: 86400};

function makeWindow(id: string, canonicalWindow: CanonicalQuotaWindow, label: string, percent: number, reset: unknown, durationSeconds: number | null): UsageWindow {
    return {
        id, canonicalWindow, label: windowLabel(canonicalWindow, label), used: null, limit: null,
        percent: Math.max(0, Math.min(1, percent)), resetAt: toEpochMs(reset), durationSeconds, unit: null,
    };
}

function ratioWindows(usages: Record<string, unknown>): UsageWindow[] {
    return RATIO_WINDOWS.flatMap(([id, canonical, label, length]) => {
        const item = recordAt(usages, id);
        const ratio = item ? toNumber(item.used_ratio) : null;
        if (!item || ratio === null)
            return [];
        const seconds = length === 'month' ? monthBefore(toEpochMs(item.reset_time)) : namedLength(length);
        return [makeWindow(id, canonical, label, ratio, item.reset_time, seconds)];
    });
}

function windowSeconds(window: Record<string, unknown> | null): number | null {
    const duration = window ? toNumber(window.duration) : null;
    const unit = window ? UNIT_SECONDS[stringAt(window, 'timeUnit') ?? ''] : undefined;
    return duration !== null && duration > 0 && unit !== undefined ? duration * unit : null;
}

function windowKind(seconds: number | null): CanonicalQuotaWindow {
    if (seconds === 5 * 3600)
        return 'five-hour';
    return seconds === 7 * 86400 ? 'weekly' : 'other';
}

function countWindow(id: string, canonical: CanonicalQuotaWindow, label: string, detail: Record<string, unknown>, seconds: number | null): UsageWindow | null {
    const limit = toNumber(detail.limit);
    const remaining = toNumber(detail.remaining);
    const used = toNumber(detail.used) ?? (limit !== null && remaining !== null ? limit - remaining : null);
    if (limit === null || limit <= 0 || used === null)
        return null;
    return makeWindow(id, canonical, label, used / limit, detail.resetTime ?? detail.reset_time, seconds);
}

export function normalizeKimiUsage(payload: unknown): UsageWindow[] {
    if (!isRecord(payload))
        return [];
    const usages = recordAt(payload, 'usages');
    const byRatio = usages ? ratioWindows(usages) : [];
    if (byRatio.length)
        return byRatio;
    const windows: UsageWindow[] = [];
    const claimed = new Set<CanonicalQuotaWindow>();
    const usage = recordAt(payload, 'usage');
    const weekly = usage ? countWindow('usage', 'weekly', '', usage, null) : null;
    if (weekly) {
        claimed.add('weekly');
        windows.push(weekly);
    }
    const limits = Array.isArray(payload.limits) ? payload.limits : [];
    limits.forEach((item, index) => {
        if (!isRecord(item))
            return;
        const seconds = windowSeconds(recordAt(item, 'window'));
        const type = claimType(claimed, windowKind(seconds), stringAt(item, 'name') ?? 'Usage Limit');
        const window = countWindow(`limit-${index}`, type.canonicalWindow, type.label, recordAt(item, 'detail') ?? item, seconds);
        if (window)
            windows.push(window);
    });
    return windows;
}

// Kimi Code serves the global and mainland China regions from different hosts.
export function kimiApiHost(configToml: string): string {
    return /api\.kimi\.ai/.test(configToml) ? 'api.kimi.ai' : 'api.kimi.com';
}
