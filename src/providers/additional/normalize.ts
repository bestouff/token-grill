import type {ProviderBalance, UsageWindow} from '../../core/types.js';

export function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | null {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function timestamp(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
}

function window(id: string, canonical: UsageWindow['canonicalWindow'], label: string, percent: number, resetAt: number | null): UsageWindow {
    return {id, canonicalWindow: canonical, label, percent: Math.max(0, Math.min(1, percent)),
        used: null, limit: null, resetAt, resetAfterSeconds: null, windowSeconds: null};
}

export function normalizeDeepSeekBalance(payload: unknown): ProviderBalance[] {
    const root = record(payload);
    if (typeof root.is_available !== 'boolean' || !Array.isArray(root.balance_infos)) return [];
    return root.balance_infos.flatMap(entry => {
        const item = record(entry);
        const available = finite(item.total_balance);
        if (available === null || typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)) return [];
        return [{currency: item.currency, available, granted: finite(item.granted_balance), toppedUp: finite(item.topped_up_balance)}];
    });
}

export function normalizeOpenCodeUsage(payload: unknown): UsageWindow[] {
    const usage = record(record(payload).usage);
    return ([['rolling', 'five-hour', 'Five-hour'], ['weekly', 'weekly', 'Weekly'], ['monthly', 'monthly', 'Monthly']] as const).flatMap(([key, canonical, label]) => {
        const item = record(usage[key]);
        const percent = finite(item.percent);
        return percent === null ? [] : [window(key, canonical, label, percent / 100, timestamp(item.resetsAt))];
    });
}

export function normalizeKimiUsage(payload: unknown): UsageWindow[] {
    const root = record(payload);
    const usages = record(root.usages);
    const current = ([['limit_5h', 'five-hour', 'Five-hour'], ['limit_7d', 'weekly', 'Weekly'],
        ['limit_month_total', 'monthly', 'Monthly total'], ['limit_month_code', 'monthly', 'Monthly code']] as const).flatMap(([key, canonical, label]) => {
        const item = record(usages[key]);
        const ratio = finite(item.used_ratio);
        return ratio === null ? [] : [window(key, canonical, label, ratio, timestamp(item.reset_time))];
    });
    if (current.length) return current;

    // Legacy Kimi CLI exposes counts rather than ratios at the same endpoint.
    const entries: Array<{entry: unknown; canonical: UsageWindow['canonicalWindow']; label: string}> =
        [{entry: root.usage, canonical: 'weekly', label: 'Weekly'}];
    for (const raw of Array.isArray(root.limits) ? root.limits : []) {
        const item = record(raw);
        const duration = finite(record(item.window).duration);
        const unit = record(item.window).timeUnit;
        const hours = unit === 'MINUTE' && duration !== null ? duration / 60 : unit === 'HOUR' ? duration : null;
        const canonical = hours === 5 ? 'five-hour' : unit === 'DAY' && duration === 7 ? 'weekly' : 'other';
        entries.push({entry: item.detail || item, canonical, label: canonical === 'five-hour' ? 'Five-hour' : typeof item.name === 'string' ? item.name : 'Usage limit'});
    }
    return entries.flatMap(({entry, canonical, label}, index) => {
        const item = record(entry);
        const limit = finite(item.limit);
        const remaining = finite(item.remaining);
        const used = finite(item.used) ?? (limit !== null && remaining !== null ? limit - remaining : null);
        if (limit === null || limit <= 0 || used === null) return [];
        return [{...window(`legacy-${index}`, canonical, label, used / limit,
            timestamp(item.resetTime ?? item.reset_time ?? item.resetAt ?? item.reset_at)), used, limit}];
    });
}
