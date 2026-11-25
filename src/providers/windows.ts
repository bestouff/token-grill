import type {CanonicalQuotaWindow} from '../core/types.js';

// Labels are data, matched by the window preference and shown only for
// windows outside the three canonical ones; the UI names those itself.
const LABELS: Record<Exclude<CanonicalQuotaWindow, 'other'>, string> = {
    'five-hour': 'Five-hour',
    weekly: 'Weekly',
    monthly: 'Monthly',
};

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
    return {canonicalWindow: 'other', label: `${name} · ${LABELS[canonicalWindow]}`};
}

export function windowLabel(canonicalWindow: CanonicalQuotaWindow, fallback: string): string {
    return canonicalWindow === 'other' ? fallback : LABELS[canonicalWindow];
}
