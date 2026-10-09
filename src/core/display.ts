import type {PanelPercentageMode, ProviderInstance, ProviderSnapshot, QuotaWindowPreference, UsageWindow} from './types.js';

export function activeProvider(providers: ProviderInstance[], activeId: string): ProviderInstance | null {
    const enabled = providers.filter(provider => provider.enabled);
    return enabled.find(provider => provider.id === activeId) ||
        enabled.find(provider => provider.showInPanel) || enabled[0] || null;
}

export function chooseWindow(snapshot: ProviderSnapshot | null, preference: QuotaWindowPreference): UsageWindow | null {
    const windows = snapshot?.windows || [];
    if (!windows.length) return null;
    if (preference === 'five-hour') {
        const selected = windows.find(window => window.canonicalWindow === 'five-hour' || /five|5.?hour|session/i.test(`${window.id} ${window.label}`));
        if (selected) return selected;
    }
    if (preference === 'weekly') {
        const selected = windows.find(window => window.canonicalWindow === 'weekly' || /week/i.test(`${window.id} ${window.label}`));
        if (selected) return selected;
    }
    if (preference === 'monthly') {
        const selected = windows.filter(window => window.canonicalWindow === 'monthly' || /month/i.test(`${window.id} ${window.label}`))
            .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1))[0];
        if (selected) return selected;
    }
    let highest: UsageWindow | null = null;
    for (const window of windows) if ((window.percent ?? -1) > (highest?.percent ?? -1)) highest = window;
    return highest;
}

export function resolveQuotaSelection(snapshot: ProviderSnapshot | null, preference: QuotaWindowPreference) {
    const windows = snapshot?.windows || [];
    if (preference === 'automatic') return {requested: preference, selected: chooseWindow(snapshot, preference), fallbackUsed: false, fallbackFrom: null};
    const exact = windows.filter(window => window.canonicalWindow === preference)
        .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1))[0];
    if (exact) return {requested: preference, selected: exact, fallbackUsed: false, fallbackFrom: null};
    return {requested: preference, selected: chooseWindow(snapshot, 'automatic'), fallbackUsed: true, fallbackFrom: preference};
}

export function displayPercent(window: UsageWindow | null, mode: PanelPercentageMode): number | null {
    if (!window || window.percent === null || window.percent === undefined) return null;
    return mode === 'remaining' ? Math.max(0, Math.min(1, 1 - window.percent)) : Math.max(0, Math.min(1, window.percent));
}

export function balanceLabel(snapshot: ProviderSnapshot | null): string | null {
    if (!snapshot?.balances?.length) return null;
    return snapshot.balances.map(balance => `${balance.currency} ${balance.available.toLocaleString(undefined, {maximumFractionDigits: 4})}`).join(' · ');
}

export function pressureClass(window: UsageWindow | null): 'neutral' | 'warning' | 'critical' {
    const used = window?.percent ?? 0;
    return used >= 0.95 ? 'critical' : used >= 0.8 ? 'warning' : 'neutral';
}

export function displayLabel(window: UsageWindow | null, mode: PanelPercentageMode): string {
    const percent = displayPercent(window, mode);
    if (percent === null) return '—';
    return `${Math.round(percent * 100)}% ${mode === 'remaining' ? 'left' : 'used'}`;
}
