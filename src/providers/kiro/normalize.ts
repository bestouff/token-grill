import type {UsageWindow} from '../../core/types.js';

export interface KiroUsageResult {
    windows: UsageWindow[];
    plan: string | null;
}

function objectAt(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function preferredNumber(value: Record<string, unknown>, precise: string, fallback: string): number | null {
    return finite(value[precise]) ?? finite(value[fallback]);
}

function epochMilliseconds(value: unknown): number | null {
    const numeric = finite(value);
    if (numeric !== null) return numeric < 10000000000 ? numeric * 1000 : numeric;
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

export function normalizeKiroUsage(payload: unknown): KiroUsageResult {
    const object = objectAt(payload);
    if (!object) return {windows: [], plan: null};
    const breakdowns = Array.isArray(object.usageBreakdownList) ? object.usageBreakdownList.map(objectAt).filter(Boolean) as Record<string, unknown>[] : [];
    const selected = breakdowns.find(item => item.resourceType === 'CREDIT') || breakdowns.find(item =>
        preferredNumber(item, 'currentUsageWithPrecision', 'currentUsage') !== null);
    const subscription = objectAt(object.subscriptionInfo);
    const planValue = subscription?.subscriptionTitle ?? subscription?.type;
    const plan = typeof planValue === 'string' && planValue ? planValue : null;
    if (!selected) return {windows: [], plan};
    const used = preferredNumber(selected, 'currentUsageWithPrecision', 'currentUsage');
    const limit = preferredNumber(selected, 'usageLimitWithPrecision', 'usageLimit');
    if (used === null && limit === null) return {windows: [], plan};
    const rawPercent = used !== null && limit !== null && limit > 0 ? used / limit : null;
    const resetAt = epochMilliseconds(selected.nextDateReset) ?? epochMilliseconds(object.nextDateReset);
    return {
        plan,
        windows: [{
            id: 'monthly-credits',
            canonicalWindow: 'monthly',
            label: 'Monthly credits',
            used,
            limit,
            percent: rawPercent === null ? null : Math.max(0, Math.min(1, rawPercent)),
            resetAt,
            resetAfterSeconds: null,
            windowSeconds: null,
            unit: 'credits',
        }],
    };
}
