import {isRecord} from './json.js';
import {emptySnapshot, type Balance, type CanonicalQuotaWindow, type LimitResetCreditSummary, type ProviderSnapshot, type UsageWindow} from './types.js';

// The last limits of an account, kept across restarts. The account name is
// left out: Token Grill writes no e-mail address to disk.
export interface StoredReading {
    plan: string | null;
    windows: UsageWindow[];
    balance: Balance | null;
    resetCredits: LimitResetCreditSummary | null;
    fetchedAt: number;
}

const CANONICAL_WINDOWS: CanonicalQuotaWindow[] = ['five-hour', 'weekly', 'monthly', 'other'];

function nullableNumber(value: unknown): value is number | null {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isWindow(value: unknown): value is UsageWindow {
    return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string' &&
        CANONICAL_WINDOWS.includes(value.canonicalWindow as CanonicalQuotaWindow) &&
        nullableNumber(value.used) && nullableNumber(value.limit) && nullableNumber(value.percent) &&
        nullableNumber(value.resetAt) && nullableNumber(value.durationSeconds) &&
        (value.unit === null || value.unit === 'credits');
}

function isBalance(value: unknown): value is Balance {
    return isRecord(value) && typeof value.amount === 'number' && Number.isFinite(value.amount) && typeof value.currency === 'string';
}

function isResetCredits(value: unknown): value is LimitResetCreditSummary {
    return isRecord(value) && typeof value.availableCount === 'number' && typeof value.fetchedAt === 'number' &&
        typeof value.stale === 'boolean' && Array.isArray(value.credits) &&
        value.credits.every(credit => isRecord(credit) && (credit.title === null || typeof credit.title === 'string') && nullableNumber(credit.expiresAt));
}

export function storedReading(snapshot: ProviderSnapshot): StoredReading | null {
    if (snapshot.quotaFetchedAt === null)
        return null;
    const {plan, windows, balance, resetCredits} = snapshot;
    return {plan, windows, balance, resetCredits: resetCredits && {...resetCredits, error: null}, fetchedAt: snapshot.quotaFetchedAt};
}

// A damaged entry is dropped as a whole, so a half-read reading never shows.
export function parseStoredReading(value: unknown): StoredReading | null {
    if (!isRecord(value) || typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt))
        return null;
    if (!(value.plan === null || typeof value.plan === 'string') || !Array.isArray(value.windows) || !value.windows.every(isWindow))
        return null;
    if (!(value.balance === null || isBalance(value.balance)) || !(value.resetCredits === null || isResetCredits(value.resetCredits)))
        return null;
    return {plan: value.plan, windows: value.windows, balance: value.balance, resetCredits: value.resetCredits, fetchedAt: value.fetchedAt};
}

// The reading is shown as it was, with its age; the next refresh replaces it.
export function restoredSnapshot(providerId: string, reading: StoredReading): ProviderSnapshot {
    return {
        ...emptySnapshot(providerId),
        state: 'stale',
        plan: reading.plan,
        windows: reading.windows,
        balance: reading.balance,
        resetCredits: reading.resetCredits && {...reading.resetCredits, stale: true},
        lastUpdated: reading.fetchedAt,
        quotaFetchedAt: reading.fetchedAt,
    };
}
