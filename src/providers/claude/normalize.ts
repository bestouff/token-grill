import type {CanonicalQuotaWindow, UsageWindow} from '../../core/types.js';

export function normalizeClaudeUsage(payload: unknown): UsageWindow[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    const object = payload as Record<string, unknown>;
    const windows: UsageWindow[] = [];
    const sources: Array<[string, CanonicalQuotaWindow]> = [
        ['five_hour', 'five-hour'],
        ['seven_day', 'weekly'],
        ['seven_day_opus', 'other'],
        ['seven_day_sonnet', 'other'],
    ];
    for (const [key, canonicalWindow] of sources) {
        const value = object[key];
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const item = value as Record<string, unknown>;
        const rawPercent = typeof item.utilization === 'number' ? item.utilization : typeof item.percent === 'number' ? item.percent : null;
        if (rawPercent === null) continue;
        const percent = rawPercent > 1 ? rawPercent / 100 : rawPercent;
        const reset = item.resets_at ?? item.resetAt ?? item.reset_at;
        const resetAt = typeof reset === 'number' ? (reset < 10000000000 ? reset * 1000 : reset) : typeof reset === 'string' ? Date.parse(reset) : null;
        windows.push({
            id: key,
            canonicalWindow,
            label: canonicalWindow === 'five-hour' ? 'Five-hour' : canonicalWindow === 'weekly' ? 'Weekly' : key.replaceAll('_', ' '),
            used: null,
            limit: null,
            percent: Math.max(0, Math.min(1, percent)),
            resetAt: Number.isFinite(resetAt) ? resetAt : null,
            resetAfterSeconds: null,
            windowSeconds: canonicalWindow === 'five-hour' ? 5 * 60 * 60 : canonicalWindow === 'weekly' ? 7 * 24 * 60 * 60 : null,
        });
    }
    return windows;
}
