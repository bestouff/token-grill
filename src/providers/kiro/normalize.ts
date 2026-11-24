import {clampFraction, isRecord, numberAt, recordAt, stringAt, toEpochMs} from '../../core/json.js';
import type {UsageWindow} from '../../core/types.js';
import {monthBefore} from '../windows.js';

export interface KiroUsage {
    windows: UsageWindow[];
    plan: string | null;
    account: string | null;
}

// Kiro reports both rounded and precise counters; the precise ones are preferred.
function preciseNumber(record: Record<string, unknown>, key: string): number | null {
    return numberAt(record, `${key}WithPrecision`) ?? numberAt(record, key);
}

export function normalizeKiroUsage(payload: unknown): KiroUsage {
    if (!isRecord(payload))
        return {windows: [], plan: null, account: null};
    const subscription = recordAt(payload, 'subscriptionInfo');
    const user = recordAt(payload, 'userInfo');
    const plan = subscription ? stringAt(subscription, 'subscriptionTitle') ?? stringAt(subscription, 'type') : null;
    const account = user ? stringAt(user, 'email') : null;
    const breakdowns = Array.isArray(payload.usageBreakdownList) ? payload.usageBreakdownList.filter(isRecord) : [];
    const credits = breakdowns.find(item => item.resourceType === 'CREDIT');
    const used = credits ? preciseNumber(credits, 'currentUsage') : null;
    const limit = credits ? preciseNumber(credits, 'usageLimit') : null;
    if (!credits || (used === null && limit === null))
        return {windows: [], plan, account};
    const resetAt = toEpochMs(credits.nextDateReset) ?? toEpochMs(payload.nextDateReset);
    return {
        plan,
        account,
        windows: [{
            id: 'monthly-credits',
            canonicalWindow: 'monthly',
            label: 'Monthly credits',
            used,
            limit,
            // A zero limit means pooled or unlimited credits, which have no meaningful percentage.
            percent: used !== null && limit !== null && limit > 0 ? clampFraction(used / limit) : null,
            resetAt,
            durationSeconds: monthBefore(resetAt),
            unit: 'credits',
        }],
    };
}
