import type {ModelRate} from './catalog.js';
import type {TokenTotals} from '../core/types.js';

export function costFor(totals: TokenTotals, rate: ModelRate | null): number | null {
    if (!rate) return null;
    return (totals.input * rate.input + totals.output * rate.output + totals.cachedInput * (rate.cachedInput ?? rate.input) + totals.cacheWrite * (rate.cacheWrite ?? rate.input)) / 1_000_000;
}

