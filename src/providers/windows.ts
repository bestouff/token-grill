import type {CanonicalQuotaWindow} from '../core/types.js';

// Labels are data, matched by the window preference and shown only for
// windows outside the three canonical ones; the UI names those itself.
const LABELS: Record<Exclude<CanonicalQuotaWindow, 'other'>, string> = {
    'five-hour': 'Five-hour',
    weekly: 'Weekly',
    monthly: 'Monthly',
};

export const FIVE_HOURS = 5 * 3600;
export const WEEK = 7 * 86400;

// A window the service names "5h" or "seven_day" lasts that long; usage pace
// needs the length to know how much of the window has passed.
export function namedLength(canonicalWindow: CanonicalQuotaWindow): number | null {
    if (canonicalWindow === 'five-hour')
        return FIVE_HOURS;
    return canonicalWindow === 'weekly' ? WEEK : null;
}

// A monthly allowance that resets on a date runs from the same day a month before.
export function monthBefore(resetAt: number | null): number | null {
    if (resetAt === null)
        return null;
    const start = new Date(resetAt);
    start.setUTCMonth(start.getUTCMonth() - 1);
    return (resetAt - start.getTime()) / 1000;
}

export interface WindowType {
    canonicalWindow: CanonicalQuotaWindow;
    label: string;
}

// The top bar and alerts key a limit by its type, so a reading keeps one window
// of each type. A second one, such as a model's own weekly limit, becomes a
// limit of its own, named after the model or pool.
export function claimType(claimed: Set<CanonicalQuotaWindow>, canonicalWindow: CanonicalQuotaWindow, name: string): WindowType {
    if (canonicalWindow === 'other')
        return {canonicalWindow, label: name};
    if (!claimed.has(canonicalWindow)) {
        claimed.add(canonicalWindow);
        return {canonicalWindow, label: LABELS[canonicalWindow]};
    }
    return {canonicalWindow: 'other', label: `${name} - ${LABELS[canonicalWindow]}`};
}

export function windowLabel(canonicalWindow: CanonicalQuotaWindow, fallback: string): string {
    return canonicalWindow === 'other' ? fallback : LABELS[canonicalWindow];
}
