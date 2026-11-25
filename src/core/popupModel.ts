// Pure presentation helpers for the top-bar popup.  Kept free of GNOME imports
// so the wording and grouping can be unit-tested.
import {activeProvider} from './display.js';
import {formatTokenCount, type HistoryMetrics} from './historyMetrics.js';
import {formatText, type Translator} from './i18n.js';
import {displayPath} from './paths.js';
import {providerMetadata} from './providerMetadata.js';
import {signInCommand} from './signIn.js';
import {durationUntil, formatDuration} from './timeMath.js';
import type {ProviderErrorCode, ProviderInstance, ProviderKind, ProviderRuntimeState, ProviderSnapshot, UsageWindow} from './types.js';

export interface ChooserAccount {
    id: string;
    displayName: string;
    shortName: string;
    accent: ProviderInstance['accent'];
    selected: boolean;
    attention: boolean;
}

export interface ChooserGroup {
    kind: ProviderKind;
    label: string;
    accounts: ChooserAccount[];
    selected: boolean;
    attention: boolean;
}

type SnapshotLookup = Pick<Map<string, Pick<ProviderSnapshot, 'error'> | null>, 'get'>;

// Drops a leading provider name ("Codex - Work" becomes "Work") so account
// buttons stay short; names that merely contain the provider are kept.
export function shortAccountName(displayName: string, providerLabel: string): string {
    const escaped = providerLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = displayName.match(new RegExp(`^${escaped}\\s*[-:/|]\\s*(.+)$`, 'i'));
    return match ? match[1]!.trim() : displayName;
}

export function accountGroups(providers: ProviderInstance[], activeId: string, snapshots: SnapshotLookup): ChooserGroup[] {
    const enabled = providers.filter(provider => provider.enabled);
    const active = activeProvider(providers, activeId);
    const groups: ChooserGroup[] = [];
    for (const provider of enabled) {
        let group = groups.find(item => item.kind === provider.kind);
        if (!group) {
            group = {kind: provider.kind, label: providerMetadata(provider.kind).label, accounts: [], selected: false, attention: false};
            groups.push(group);
        }
        const selected = provider.id === active?.id;
        const attention = Boolean(snapshots.get(provider.id)?.error);
        group.accounts.push({
            id: provider.id,
            displayName: provider.displayName,
            shortName: shortAccountName(provider.displayName, group.label),
            accent: provider.accent,
            selected,
            attention,
        });
        group.selected ||= selected;
        group.attention ||= attention;
    }
    return groups;
}

function formatQuotaNumber(value: number): string {
    return value.toLocaleString(undefined, {maximumFractionDigits: 6});
}

function quotaValueLabel(tr: Translator, window: Partial<UsageWindow>): string {
    const {_} = tr;
    if (window.unit !== 'credits' || window.used == null || !Number.isFinite(window.used))
        return '';
    const used = formatQuotaNumber(window.used);
    if (window.limit == null || !Number.isFinite(window.limit) || window.limit <= 0)
        return formatText(_('%s credits used - pooled or unlimited'), used);
    return formatText(_('%s of %s credits'), used, formatQuotaNumber(window.limit));
}

export function windowCaption(tr: Translator, window: Partial<UsageWindow> | null, now = Date.now()): string {
    const {_} = tr;
    if (!window)
        return _('No data yet');
    const quota = quotaValueLabel(tr, window);
    const parts = durationUntil(window.resetAt ?? null, now);
    const resetsNow = parts !== null && (parts.expired || parts.totalMinutes < 1);
    if (quota) {
        if (!parts)
            return formatText(_('%s - reset time unknown'), quota);
        if (resetsNow)
            return formatText(_('%s - resets now'), quota);
        return formatText(_('%s - resets in %s'), quota, formatDuration(tr, parts, true));
    }
    if (!parts)
        return _('Reset time unknown');
    if (resetsNow)
        return _('Resets now');
    return formatText(_('Resets in %s'), formatDuration(tr, parts, true));
}

function updatedText(tr: Translator, clockText: string, fetchedAt: number, now: number): string {
    const {_, ngettext} = tr;
    const minutes = Math.max(0, Math.floor((now - fetchedAt) / 60000));
    if (minutes < 1)
        return formatText(_('Updated %s - just now'), clockText);
    if (minutes < 60)
        return formatText(ngettext('Updated %s - %d min ago', 'Updated %s - %d min ago', minutes), clockText, minutes);
    const hours = Math.floor(minutes / 60);
    return formatText(ngettext('Updated %s - %d h ago', 'Updated %s - %d h ago', hours), clockText, hours);
}

export function refreshStatusText(
    tr: Translator,
    snapshot: Pick<ProviderSnapshot, 'quotaFetchedAt'> | null,
    runtime: Pick<ProviderRuntimeState, 'phase' | 'outcome' | 'completedAt'> | null,
    clock: (timestamp: number) => string,
    now = Date.now()
): string {
    const {_} = tr;
    switch (runtime?.phase) {
    case 'queued':
        return _('Waiting to refresh...');
    case 'fetching-limits':
        return _('Refreshing limits...');
    case 'fetching-reset-credits':
        return _('Limits updated, checking reset credits...');
    case 'scanning-history':
        return _('Limits updated, scanning history...');
    }
    const fetchedAt = snapshot?.quotaFetchedAt ?? null;
    if (runtime?.outcome === 'failed' && fetchedAt)
        return formatText(_('Refresh failed - showing data from %s'), clock(fetchedAt));
    if (runtime?.outcome === 'failed')
        return _('Refresh failed');
    if (runtime?.outcome === 'partial')
        return _('Limits updated - some sources unavailable');
    if (runtime?.outcome === 'unchanged' && runtime.completedAt)
        return formatText(_('Checked %s - no change'), clock(runtime.completedAt));
    if (fetchedAt)
        return updatedText(tr, clock(fetchedAt), fetchedAt, now);
    return _('Not refreshed yet');
}

// One line of local-history figures, or null when the account has none to show.
export function historySummary(tr: Translator, metrics: HistoryMetrics): string | null {
    const {_} = tr;
    switch (metrics.state) {
    case 'unsupported':
    case 'off':
        return null;
    case 'waiting':
        return _('Local history: waiting for the first scan');
    case 'updating':
        return _('Local history: updating...');
    case 'failed':
        return _('Local history: scan failed');
    }
    const today = formatTokenCount(metrics.todayTokens);
    const month = formatTokenCount(metrics.monthTokens);
    if (metrics.monthCost === null)
        return formatText(_('Today %s tokens - 30 days %s tokens'), today, month);
    return formatText(_('Today %s tokens - 30 days %s tokens - about $%s at API prices'), today, month, metrics.monthCost.toFixed(2));
}

type HintInstance = Pick<ProviderInstance, 'kind' | 'app' | 'accountHome'>;

// Provider messages state the problem; the fix is added here once, per service.
// A CLI signed in to another home needs the variable that points it there.
function withSignInHint(tr: Translator, {kind, app, accountHome}: HintInstance, message: string): string {
    const {_} = tr;
    const command = signInCommand({app, accountHome});
    if (command?.home)
        return formatText(_('%s Run %s with %s set to %s.'), message, command.login, command.home.variable, displayPath(command.home.path));
    if (app === 'opencode')
        return formatText(_('%s Open OpenCode and sign in again.'), message);
    if (app === 'copilot-cli')
        return formatText(_('%s Run copilot and sign in with /login.'), message);
    if (app === 'cursor-agent')
        return formatText(_('%s Run agent login.'), message);
    const templates: Record<ProviderKind, string> = {
        codex: _('%s Run codex login.'),
        claude: _('%s Run claude auth login.'),
        kiro: _('%s Run kiro-cli login.'),
        antigravity: _('%s Sign in again with Antigravity or agy.'),
        copilot: _('%s Run gh auth login.'),
        'opencode-go': _('%s Run opencode auth login.'),
        deepseek: _('%s Check the DeepSeek API key in Preferences.'),
        kimi: _('%s Start kimi and run /login.'),
        cursor: _('%s Open Cursor and sign in again, or run agent login and add the Cursor CLI account.'),
    };
    return formatText(templates[kind], message);
}

export function errorText(tr: Translator, snapshot: Pick<ProviderSnapshot, 'error' | 'errorInfo'> | null, instance: HintInstance): string | null {
    const {_} = tr;
    if (!snapshot?.error)
        return null;
    switch (snapshot.errorInfo?.recovery) {
    case 'reauthenticate':
        return withSignInHint(tr, instance, snapshot.error);
    case 'retry':
        return formatText(_('%s Try again later.'), snapshot.error);
    default:
        return snapshot.error;
    }
}

function codeErrorText({_}: Translator, code: ProviderErrorCode): string {
    const texts: Record<ProviderErrorCode, string> = {
        'auth-missing': _('The account is not signed in.'),
        'auth-expired': _('The sign-in has expired.'),
        'auth-invalid': _('The sign-in was not accepted.'),
        'unsupported-account': _('This account type is not supported.'),
        dependency: _('A library that this account needs is missing.'),
        permission: _('Token Grill is not allowed to read the sign-in.'),
        offline: _('The service could not be reached.'),
        timeout: _('The service did not answer in time.'),
        'rate-limited': _('The service is limiting requests.'),
        http: _('The service answered with an error.'),
        'response-shape': _('The service sent a response that could not be read.'),
        'local-history': _('The local usage history could not be updated.'),
        internal: _('Token Grill could not read this account.'),
    };
    return texts[code];
}

// A snapshot from the service names its error by code and message id, without text. Until the
// message table exists, the popup shows the generic text of the code with its correction.
export function withCodeErrorText(tr: Translator, snapshot: ProviderSnapshot): ProviderSnapshot {
    const info = snapshot.errorInfo;
    if (info === null)
        return {...snapshot, error: null};
    const message = codeErrorText(tr, info.code);
    return {...snapshot, error: message, errorInfo: {code: info.code, message, recovery: info.recovery}};
}
