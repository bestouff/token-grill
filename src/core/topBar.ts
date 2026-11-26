// What the top bar shows: one entry per service, holding the accounts the user
// ticked in the popup.  Pure, so the Shell code only draws the result.
import {limitName} from './display.js';
import type {Translator} from './i18n.js';
import {BALANCE_KEY} from './types.js';
import type {
    AccentValue,
    Balance,
    PaceLevel,
    ProviderInstance,
    ProviderKind,
    ProviderSnapshot,
    SnapshotWindow,
    TopBarSelection,
} from './types.js';

export interface TopBarAccount {
    id: string;
    name: string;
    accent: AccentValue;
    limits: SnapshotWindow[];
    balance: Balance | null;
    // The balance is below the amount the user asked to be warned at.
    low: boolean;
    // Nothing to draw: the ticked limits are not in the latest reading.
    missing: boolean;
    // How fast the shown limits are used, when the account shows its pace.
    pace: PaceLevel | null;
}

export interface TopBarGroup {
    kind: ProviderKind;
    accounts: TopBarAccount[];
}

export function isShown(instance: Pick<ProviderInstance, 'topBar'>): boolean {
    return instance.topBar.automatic || instance.topBar.limits.length > 0;
}

// One line for preferences, which have no readings: limits are named from their keys.
export function topBarSummary(tr: Translator, selection: TopBarSelection): string {
    const {_} = tr;
    if (selection.automatic)
        return _('Picked automatically');
    if (!selection.limits.length)
        return _('Not in the top bar');
    return selection.limits.map(key => {
        if (key === BALANCE_KEY)
            return _('Balance');
        const canonical = (['five-hour', 'weekly', 'monthly'] as const).find(window => window === key);
        return canonical ? limitName(tr, {id: canonical, canonicalWindow: canonical, label: ''}) : key.replaceAll('_', ' ');
    }).join(', ');
}

export function topBarGroups(providers: ProviderInstance[], snapshots: Map<string, ProviderSnapshot>): TopBarGroup[] {
    const groups: TopBarGroup[] = [];
    for (const provider of providers) {
        if (!provider.enabled || !isShown(provider))
            continue;
        let group = groups.find(item => item.kind === provider.kind);
        if (!group) {
            group = {kind: provider.kind, accounts: []};
            groups.push(group);
        }
        const snapshot = snapshots.get(provider.id) ?? null;
        const limits = snapshot ? snapshot.windows.filter(window => snapshot.shownLimits.includes(window.key)) : [];
        // Pick Automatically shows the balance meter of a balance service, so it warns too.
        const showsBalance = provider.topBar.limits.includes(BALANCE_KEY) || limits.some(window => window.key === BALANCE_KEY);
        const balance = showsBalance ? snapshot?.balance ?? null : null;
        const low = balance !== null && provider.lowBalance !== null && balance.amount < provider.lowBalance;
        const pace = provider.showPace ? snapshot?.pace?.state ?? null : null;
        group.accounts.push({id: provider.id, name: provider.displayName, accent: provider.accent, limits, balance, low, missing: !limits.length && !balance, pace});
    }
    return groups;
}
