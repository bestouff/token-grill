import type {ProviderSnapshot} from './types.js';

/**
 * A stable, deliberately small representation of the data users care about.
 * Fetch times, errors, and refresh state are excluded so a successful check
 * with identical values is correctly reported as "no change".
 */
export function snapshotFingerprint(snapshot: ProviderSnapshot | null): string {
    if (!snapshot)
        return '';

    return JSON.stringify({
        plan: snapshot.plan,
        windows: snapshot.windows,
        resetCredits: snapshot.resetCredits ? {
            supported: snapshot.resetCredits.supported,
            availableCount: snapshot.resetCredits.availableCount,
            totalEarnedCount: snapshot.resetCredits.totalEarnedCount,
            nextExpiresAt: snapshot.resetCredits.nextExpiresAt,
            credits: snapshot.resetCredits.credits,
        } : null,
        totals: snapshot.totals,
        todayTotals: snapshot.todayTotals,
        monthTotals: snapshot.monthTotals,
        todayCost: snapshot.todayCost,
        monthCost: snapshot.monthCost,
    });
}

export function quotaFingerprint(snapshot: ProviderSnapshot | null): string {
    if (!snapshot)
        return '';
    return JSON.stringify({plan: snapshot.plan, windows: snapshot.windows});
}
