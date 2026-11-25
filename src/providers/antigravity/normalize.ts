import {clampFraction, isRecord, numberAt, recordAt, stringAt, toEpochMs} from '../../core/json.js';
import type {CanonicalQuotaWindow, UsageWindow} from '../../core/types.js';
import {windowLabel} from '../windows.js';

export interface QuotaSummaryBucket {
    canonicalWindow: CanonicalQuotaWindow;
    remainingFraction: number;
    resetAt: number | null;
}

const BUCKET_WINDOWS: Record<string, CanonicalQuotaWindow> = {
    '5h': 'five-hour',
    weekly: 'weekly',
};

// The subscription tier from a loadCodeAssist response.
export function antigravityPlan(payload: unknown): string | null {
    const tier = isRecord(payload) ? recordAt(payload, 'currentTier') : null;
    return tier ? stringAt(tier, 'name') : null;
}

// retrieveUserQuotaSummary groups models (Gemini, Claude and GPT) and gives each
// group its own five-hour and weekly bucket.
export function extractQuotaSummaryBuckets(payload: unknown): QuotaSummaryBucket[] {
    const groups = isRecord(payload) && Array.isArray(payload.groups) ? payload.groups.filter(isRecord) : [];
    const buckets: QuotaSummaryBucket[] = [];
    for (const group of groups) {
        const items = Array.isArray(group.buckets) ? group.buckets.filter(isRecord) : [];
        for (const bucket of items) {
            const canonicalWindow = BUCKET_WINDOWS[stringAt(bucket, 'window') ?? ''];
            const remainingFraction = numberAt(bucket, 'remainingFraction');
            if (canonicalWindow && remainingFraction !== null)
                buckets.push({canonicalWindow, remainingFraction: clampFraction(remainingFraction), resetAt: toEpochMs(bucket.resetTime)});
        }
    }
    return buckets;
}

// The tightest bucket decides what the user can do next, so the lowest
// remaining fraction wins; ties go to the earliest reset.
function tighter(a: QuotaSummaryBucket, b: QuotaSummaryBucket): QuotaSummaryBucket {
    if (a.remainingFraction !== b.remainingFraction)
        return a.remainingFraction < b.remainingFraction ? a : b;
    if (b.resetAt !== null && (a.resetAt === null || b.resetAt < a.resetAt))
        return b;
    return a;
}

export function normalizeQuotaSummary(payload: unknown): UsageWindow[] {
    const tightest = new Map<CanonicalQuotaWindow, QuotaSummaryBucket>();
    for (const bucket of extractQuotaSummaryBuckets(payload)) {
        const current = tightest.get(bucket.canonicalWindow);
        tightest.set(bucket.canonicalWindow, current ? tighter(current, bucket) : bucket);
    }
    return [...tightest.values()].map(bucket => ({
        id: bucket.canonicalWindow,
        canonicalWindow: bucket.canonicalWindow,
        label: windowLabel(bucket.canonicalWindow, bucket.canonicalWindow),
        used: null,
        limit: null,
        percent: 1 - bucket.remainingFraction,
        resetAt: bucket.resetAt,
        unit: null,
    }));
}
