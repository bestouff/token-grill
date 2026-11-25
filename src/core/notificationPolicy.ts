import {formatMoney, limitName} from './display.js';
import {formatText, type Translator} from './i18n.js';
import {parseRecord, stringAt} from './json.js';
import {providerMetadata} from './providerMetadata.js';
import {durationUntil, formatDuration} from './timeMath.js';
import {limitKey, orderedLimits, shownLimits} from './topBar.js';
import type {Balance, PanelPercentageMode, ProviderInstance, ProviderSnapshot, UsageWindow} from './types.js';

export interface NotificationCheckpoint {
    resetIdentity: string;
    lastNotifiedBucket: number;
    configuredStep: number;
}

// Read at a glance: the source names service and account, the title the limit and what is left.
export interface NotificationText {
    source: string;
    title: string;
    body: string;
}

const MINUTE_MS = 60_000;

// Shown by the test notification when the account has no usage data yet.
const PREVIEW_CONSUMED = 0.34;

// Milestone steps are multiples of 5 between 5 % and 50 %.
export function clampStep(stepPercent: number): number {
    return Math.max(5, Math.min(50, Math.round(stepPercent / 5) * 5));
}

export function notificationBucket(percent: number, stepPercent: number): number {
    const consumed = Math.max(0, Math.min(100, percent * 100));
    return Math.floor((consumed + 1e-6) / clampStep(stepPercent));
}

export function notificationKey(instanceId: string, window: Pick<UsageWindow, 'id' | 'canonicalWindow'>): string {
    return `${instanceId}:${limitKey(window)}`;
}

const LEGACY_SUFFIX = ':selected-limit';

// Services report the same reset a few hundred milliseconds apart from one request to the next.
function roundedReset(resetAt: number): number {
    return Math.round(resetAt / MINUTE_MS) * MINUTE_MS;
}

// 0.3.x kept one alert state per account; its reset identity starts with the limit it
// followed, so the state moves to that limit's key and no alert fires again.
export function migrateNotificationState<T extends {resetIdentity: string}>(windows: Record<string, T>): Record<string, T> {
    const migrated: Record<string, T> = {};
    for (const [key, state] of Object.entries(windows)) {
        // The file is our own but may be damaged; one bad entry must not stop the start.
        if (typeof state?.resetIdentity !== 'string')
            continue;
        if (!key.endsWith(LEGACY_SUFFIX)) {
            migrated[key] = state;
            continue;
        }
        const id = key.slice(0, -LEGACY_SUFFIX.length);
        const [limit = '', reset = ''] = state.resetIdentity.split(':');
        const resetAt = Number(reset);
        const resetIdentity = reset !== '' && Number.isFinite(resetAt) ? `${limit}:${roundedReset(resetAt)}` : state.resetIdentity;
        if (limit)
            migrated[`${id}:${limit}`] ??= {...state, resetIdentity};
    }
    return migrated;
}

// A limit with a known reset starts over when the reset passes. One without a reset
// time, such as a prepaid balance after a top-up, starts over when its reading falls.
export function nextCheckpoint(
    previous: NotificationCheckpoint | null,
    resetIdentity: string,
    bucket: number,
    stepPercent: number,
    resetKnown: boolean
): NotificationCheckpoint {
    const fell = !resetKnown && previous !== null && bucket < previous.lastNotifiedBucket;
    const carried = previous?.resetIdentity === resetIdentity && !fell ? previous.lastNotifiedBucket : 0;
    return {resetIdentity, lastNotifiedBucket: Math.max(bucket, carried), configuredStep: stepPercent};
}

export interface MilestoneCheck {
    notify: boolean;
    consumed: number;
    checkpoint: NotificationCheckpoint;
}

// One limit's reading against its last alert: whether to alert now, and the state to keep.
export function checkMilestone(
    previous: NotificationCheckpoint | null,
    window: Pick<UsageWindow, 'id' | 'canonicalWindow' | 'resetAt'> & {percent: number},
    stepPercent: number
): MilestoneCheck {
    const step = clampStep(stepPercent);
    const consumed = Math.max(0, Math.min(1, window.percent));
    const bucket = notificationBucket(consumed, step);
    const resetIdentity = `${limitKey(window)}:${window.resetAt === null ? 'unknown' : roundedReset(window.resetAt)}`;
    return {
        notify: shouldNotifyMilestone(previous, resetIdentity, bucket, step),
        consumed,
        checkpoint: nextCheckpoint(previous, resetIdentity, bucket, step, window.resetAt !== null),
    };
}

// Like milestones, the first reading after start only seeds the state.
export function shouldNotifyLowBalance(previousLow: boolean | null, low: boolean): boolean {
    return previousLow === false && low;
}

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

export function parseTestNotificationRequest(value: string): {providerId: string; nonce: string} | null {
    const request = parseRecord(value);
    const providerId = request ? stringAt(request, 'providerId') : null;
    const nonce = request ? stringAt(request, 'nonce') : null;
    if (!providerId || !nonce || providerId.length > 256 || nonce.length > 256)
        return null;
    return {providerId, nonce};
}

export function shouldNotifyMilestone(
    previous: NotificationCheckpoint | null,
    resetIdentity: string,
    bucket: number,
    stepPercent: number
): boolean {
    // Startup, a newly selected quota window, and a changed notification step
    // seed state silently. Alerts represent crossings observed by Token Grill,
    // not historical milestones replayed when an account is first loaded.
    if (!previous || previous.resetIdentity !== resetIdentity || previous.configuredStep !== stepPercent)
        return false;
    return bucket >= 1 && bucket > previous.lastNotifiedBucket;
}
