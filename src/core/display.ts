import {formatText, type Translator} from './i18n.js';
import {BALANCE_KEY} from './types.js';
import type {
    Balance,
    PanelPercentageMode,
    ProviderInstance,
    ProviderSnapshot,
    UsageWindow,
} from './types.js';

export function limitName(tr: Translator, window: Pick<UsageWindow, 'id' | 'canonicalWindow' | 'label'>): string {
    const {_} = tr;
    if (window.id === BALANCE_KEY)
        return _('Balance');
    switch (window.canonicalWindow) {
    case 'five-hour':
        return _('Five-hour');
    case 'weekly':
        return _('Weekly');
    case 'monthly':
        return _('Monthly');
    default:
        return window.label;
    }
}

export function activeProvider(providers: ProviderInstance[], activeId: string): ProviderInstance | null {
    const enabled = providers.filter(provider => provider.enabled);
    return enabled.find(provider => provider.id === activeId) ?? enabled[0] ?? null;
}

// Pick Automatically shows the limit with the most usage.
export function mostUsedWindow(snapshot: Pick<ProviderSnapshot, 'windows'> | null): UsageWindow | null {
    let highest: UsageWindow | null = null;
    for (const window of snapshot?.windows ?? []) {
        if ((window.percent ?? -1) > (highest?.percent ?? -1))
            highest = window;
    }
    return highest;
}

export function displayPercent(window: UsageWindow | null, mode: PanelPercentageMode): number | null {
    if (window?.percent == null)
        return null;
    const used = Math.max(0, Math.min(1, window.percent));
    return mode === 'remaining' ? 1 - used : used;
}

export function pressureClass(window: UsageWindow | null): 'neutral' | 'warning' | 'critical' {
    const used = window?.percent ?? 0;
    if (used >= 0.95)
        return 'critical';
    if (used >= 0.8)
        return 'warning';
    return 'neutral';
}

export function displayLabel(tr: Translator, window: UsageWindow | null, mode: PanelPercentageMode): string {
    const {_} = tr;
    const percent = displayPercent(window, mode);
    if (percent === null)
        return '-';
    const rounded = Math.round(percent * 100);
    return mode === 'remaining' ? formatText(_('%d%% left'), rounded) : formatText(_('%d%% used'), rounded);
}

// A prepaid amount in its own currency, such as "$12.40".
export function formatMoney(balance: Balance, digits: number): string {
    return new Intl.NumberFormat(undefined, {
        style: 'currency', currency: balance.currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(balance.amount);
}
