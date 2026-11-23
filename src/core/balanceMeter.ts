// A prepaid balance as a meter. The service reports only what is left, so the
// amount after the most recent top-up counts as full: any rise in the balance is
// a top-up, and spending never moves the full amount.
import {BALANCE_KEY, type Balance, type UsageWindow} from './types.js';

export interface BalanceReference {
    currency: string;
    full: number;
    last: number;
}

export function nextBalanceReference(previous: BalanceReference | null, balance: Balance): BalanceReference {
    const startOver = !previous || previous.currency !== balance.currency || balance.amount > previous.last;
    return {currency: balance.currency, full: startOver ? balance.amount : previous.full, last: balance.amount};
}

export function balanceWindow(balance: Balance, reference: BalanceReference): UsageWindow {
    const used = reference.full > 0 ? 1 - balance.amount / reference.full : 1;
    return {
        id: BALANCE_KEY, canonicalWindow: 'other', label: 'Balance', used: null, limit: null,
        percent: Math.max(0, Math.min(1, used)), resetAt: null, durationSeconds: null, unit: null,
    };
}
