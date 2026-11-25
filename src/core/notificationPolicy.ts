import {formatMoney, limitName} from './display.js';
import {formatText, type Translator} from './i18n.js';
import {providerMetadata} from './providerMetadata.js';
import {durationUntil, formatDuration} from './timeMath.js';
import {orderedLimits, shownLimits} from './topBar.js';
import type {Alert, Balance, PanelPercentageMode, ProviderInstance, ProviderSnapshot, UsageWindow} from './types.js';

// Read at a glance: the source names service and account, the title the limit and what is left.
export interface NotificationText {
    source: string;
    title: string;
    body: string;
}

// Shown by the test notification when the account has no usage data yet.
const PREVIEW_CONSUMED = 0.34;

function sourceTitle(tr: Translator, serviceLabel: string, accountName: string): string {
    // Translators: a notification source; the service, then the account name.
    return formatText(tr._('%s - %s'), serviceLabel, accountName);
}

function readingTitle(tr: Translator, window: Pick<UsageWindow, 'id' | 'canonicalWindow' | 'label'>, consumed: number, mode: PanelPercentageMode): string {
    const {_} = tr;
    const clamped = Math.max(0, Math.min(1, consumed));
    const name = limitName(tr, window);
    if (mode === 'remaining')
        return formatText(_('%s: %d%% left'), name, Math.round((1 - clamped) * 100));
    return formatText(_('%s: %d%% used'), name, Math.round(clamped * 100));
}

function resetText(tr: Translator, resetAt: number | null, now: number): string {
    const {_} = tr;
    const parts = durationUntil(resetAt, now);
    if (!parts)
        return _('Reset time unknown');
    if (parts.expired || parts.totalMinutes < 1)
        return _('Resets now');
    return formatText(_('Resets in %s'), formatDuration(tr, parts, true));
}

export function limitNotificationText(
    tr: Translator,
    serviceLabel: string,
    instance: Pick<ProviderInstance, 'displayName'>,
    window: Pick<UsageWindow, 'id' | 'canonicalWindow' | 'label' | 'resetAt'>,
    consumed: number,
    mode: PanelPercentageMode,
    now: number
): NotificationText {
    return {
        source: sourceTitle(tr, serviceLabel, instance.displayName),
        title: readingTitle(tr, window, consumed, mode),
        body: resetText(tr, window.resetAt, now),
    };
}

export function balanceNotificationText(
    tr: Translator,
    serviceLabel: string,
    instance: Pick<ProviderInstance, 'displayName' | 'lowBalance'>,
    balance: Balance
): NotificationText {
    const {_} = tr;
    return {
        source: sourceTitle(tr, serviceLabel, instance.displayName),
        title: formatText(_('Balance: %s left'), formatMoney(balance, 2)),
        body: formatText(_('Below your %s warning'), formatMoney({amount: instance.lowBalance ?? 0, currency: balance.currency}, 2)),
    };
}

// The account's first top-bar limit as it reads now, so the preview looks like a real alert.
export function testNotificationText(
    tr: Translator,
    serviceLabel: string,
    instance: Pick<ProviderInstance, 'kind' | 'displayName' | 'topBar'>,
    snapshot: Pick<ProviderSnapshot, 'windows'> | null,
    mode: PanelPercentageMode,
    now: number
): NotificationText {
    const {_} = tr;
    const window = shownLimits(instance, snapshot)[0] ?? orderedLimits(snapshot)[0] ?? null;
    const preview = {id: '', canonicalWindow: providerMetadata(instance.kind).quotaWindows[0] ?? 'other', label: '', resetAt: null};
    const consumed = window?.percent ?? PREVIEW_CONSUMED;
    return {
        source: sourceTitle(tr, serviceLabel, instance.displayName),
        title: readingTitle(tr, window ?? preview, consumed, mode),
        body: formatText(_('Test notification - %s'), resetText(tr, window?.resetAt ?? null, now)),
    };
}

// The service decides when an alert is due; its text follows the user's language and percentage mode.
// An alert without the reading its kind needs, or of a kind this version does not know, shows nothing.
export function alertText(
    tr: Translator,
    alert: Pick<Alert, 'kind' | 'window' | 'fraction' | 'balance' | 'lowBalance'>,
    instance: Pick<ProviderInstance, 'kind' | 'displayName' | 'topBar'>,
    snapshot: Pick<ProviderSnapshot, 'windows'> | null,
    mode: PanelPercentageMode,
    now: number
): NotificationText | null {
    const serviceLabel = providerMetadata(instance.kind).label;
    switch (alert.kind) {
    case 'milestone':
        if (alert.window === null || alert.fraction === null)
            return null;
        return limitNotificationText(tr, serviceLabel, instance, alert.window, alert.fraction, mode, now);
    case 'low-balance':
        if (alert.balance === null || alert.lowBalance === null)
            return null;
        return balanceNotificationText(tr, serviceLabel, {displayName: instance.displayName, lowBalance: alert.lowBalance}, alert.balance);
    case 'test':
        return testNotificationText(tr, serviceLabel, instance, snapshot, mode, now);
    default:
        return null;
    }
}
