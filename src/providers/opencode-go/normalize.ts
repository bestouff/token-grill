// OpenCode Go reports one pool for the whole subscription, whatever model is used.
// Fields from the community-observed response: {rolling|weekly|monthly: {status, percent, resetsAt}},
// optionally wrapped in `usage`.
import {clampFraction, isRecord, numberAt, recordAt, stringAt, toEpochMs} from '../../core/json.js';
import type {CanonicalQuotaWindow, UsageWindow} from '../../core/types.js';
import {windowLabel} from '../windows.js';

const WINDOWS: [string, CanonicalQuotaWindow][] = [
    ['rolling', 'five-hour'],
    ['weekly', 'weekly'],
    ['monthly', 'monthly'],
];

export function normalizeOpenCodeGoUsage(payload: unknown): UsageWindow[] {
    const root = isRecord(payload) ? recordAt(payload, 'usage') ?? payload : {};
    return WINDOWS.flatMap(([id, canonicalWindow]) => {
        const item = recordAt(root, id);
        const percent = item ? numberAt(item, 'percent') : null;
        if (!item || percent === null)
            return [];
        // A rate-limited window is closed before its percentage reaches 100.
        const used = stringAt(item, 'status') === 'rate-limited' ? 1 : clampFraction(percent / 100);
        return [{
            id, canonicalWindow, label: windowLabel(canonicalWindow, id), used: null, limit: null,
            percent: used, resetAt: toEpochMs(item.resetsAt), unit: null,
        }];
    });
}
