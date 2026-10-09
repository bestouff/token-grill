// @ts-nocheck
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {balanceLabel, resolveQuotaSelection, displayLabel, pressureClass} from '../core/display.js';
import {formatResetCountdown} from '../core/timeMath.js';
import {providerMetadata} from '../core/providerMetadata.js';
import {historyMetrics} from '../core/historyMetrics.js';
import type {ProviderInstance, ProviderRuntimeState, ProviderSnapshot, UsageWindow} from '../core/types.js';
import {formatReset, iconFor} from './accountChip.js';
import {makeShellInteractive} from './interaction.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

function text(value, style = '') { return new St.Label({text: value, style_class: style, y_align: Clutter.ActorAlign.CENTER}); }

function roundedPath(cr, x, y, width, height) {
    if (width <= 0) return;
    const radius = Math.min(height / 2, width / 2);
    cr.newPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

function drawMeter(area, fraction, color) {
    const cr = area.get_context();
    const width = area.get_width();
    const height = area.get_height();
    roundedPath(cr, 0, 0, width, height);
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25); cr.fill();
    if (fraction === null || fraction === undefined) return;
    cr.save(); cr.rectangle(0, 0, width * Math.max(0, Math.min(1, fraction)), height); cr.clip();
    roundedPath(cr, 0, 0, width, height); cr.setSourceRGBA(...color, 1); cr.fill(); cr.restore();
}

function pressureColor(window: UsageWindow | null) {
    const pressure = pressureClass(window);
    return pressure === 'critical' ? [0.95, 0.28, 0.2] : pressure === 'warning' ? [0.95, 0.62, 0.2] : [0.96, 0.72, 0.2];
}

function refreshButton(callback) {
    const item = new St.Button({style_class: 'tokengrill-icon-button', reactive: true, can_focus: true, track_hover: true});
    item._icon = new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16, style_class: 'system-status-icon'});
    item.set_child(item._icon);
    item.set_accessible_name('Refresh this account');
    item.connect('clicked', callback);
    return makeShellInteractive(item, 'Refresh this account');
}

export const ProviderDashboard = GObject.registerClass(class ProviderDashboard extends St.BoxLayout {
    _init(basePath, actions = {}) {
        super._init({vertical: true, style_class: 'tokengrill-provider-pane', x_expand: true});
        this._basePath = basePath;
        this._actions = actions;
        this._build();
    }

    _build() {
        this._header = new St.BoxLayout({style_class: 'tokengrill-pane-header', x_expand: true});
        this._logoBadge = new St.Bin({style_class: 'tokengrill-logo-badge', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._header.add_child(this._logoBadge);
        this._identity = new St.BoxLayout({vertical: true, style_class: 'tokengrill-pane-identity', x_expand: true});
        this._title = text('', 'tokengrill-pane-title');
        this._subtitle = text('', 'tokengrill-secondary');
        this._refreshStatus = text('', 'tokengrill-refresh-status');
        this._identity.add_child(this._title); this._identity.add_child(this._subtitle); this._identity.add_child(this._refreshStatus);
        this._header.add_child(this._identity);
        this._status = text('', 'tokengrill-status-pill'); this._header.add_child(this._status);
        this._refreshButton = refreshButton(() => this._actions.refresh?.(this._instance)); this._header.add_child(this._refreshButton);
        this.add_child(this._header);

        this._summary = new St.BoxLayout({style_class: 'tokengrill-summary', x_expand: true});
        this._summaryText = new St.BoxLayout({vertical: true, x_expand: true});
        this._summaryValue = text('—', 'tokengrill-summary-value');
        this._summaryCaption = text('Waiting for quota data', 'tokengrill-summary-caption');
        this._summaryText.add_child(this._summaryValue); this._summaryText.add_child(this._summaryCaption); this._summary.add_child(this._summaryText);
        this._summaryReset = text('', 'tokengrill-summary-reset'); this._summary.add_child(this._summaryReset); this.add_child(this._summary);

        const windows = new St.BoxLayout({style_class: 'tokengrill-window-grid', x_expand: true});
        this._windowCards = {fiveHour: this._makeWindowCard('Five-hour', 'five-hour'), weekly: this._makeWindowCard('Weekly', 'weekly'), monthly: this._makeWindowCard('Monthly', 'monthly')};
        windows.add_child(this._windowCards.fiveHour.root); windows.add_child(this._windowCards.weekly.root); windows.add_child(this._windowCards.monthly.root); this.add_child(windows);
        this._additionalWindows = new St.BoxLayout({vertical: true, style_class: 'tokengrill-window-grid', x_expand: true});
        this.add_child(this._additionalWindows);

        this._credits = this._makeCreditsCard();
        this.add_child(this._credits.root); this.add_child(this._credits.details);

        const metrics = new St.BoxLayout({style_class: 'tokengrill-metrics', x_expand: true});
        this._today = this._metric('Today'); this._month = this._metric('30 days'); this._cost = this._metric('API est. · 30 days');
        metrics.add_child(this._today.root); metrics.add_child(this._month.root); metrics.add_child(this._cost.root); this.add_child(metrics);

        this._errorRow = new St.BoxLayout({style_class: 'tokengrill-error-row', x_expand: true});
        this._errorIcon = new St.Icon({icon_name: 'dialog-warning-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.START});
        this._errorText = new St.Label({text: '', style_class: 'tokengrill-error-text', y_align: Clutter.ActorAlign.START, x_expand: true});
        this._errorText.clutter_text.line_wrap = true;
        this._signInButton = makeShellInteractive(new St.Button({label: _('Sign in'), style_class: 'tokengrill-sign-in-button', reactive: true, can_focus: true, track_hover: true, x_align: Clutter.ActorAlign.START}), 'Sign in to this provider');
        this._signInButton.connect('clicked', () => this._launchLogin());
        this._signInButton.hide();
        this._errorRow.add_child(this._errorIcon); this._errorRow.add_child(this._errorText); this._errorRow.add_child(this._signInButton); this._errorRow.hide(); this.add_child(this._errorRow);
    }

    _metric(title) {
        const root = new St.BoxLayout({vertical: true, style_class: 'tokengrill-metric', x_expand: true});
        root.add_child(text(title.toUpperCase(), 'tokengrill-metric-label'));
        const value = text('—', 'tokengrill-metric-value'); root.add_child(value);
        const unit = text('', 'tokengrill-metric-unit'); root.add_child(unit); return {root, value, unit};
    }

    _makeWindowCard(title, canonical) {
        const root = makeShellInteractive(new St.Button({style_class: 'tokengrill-window-card', reactive: true, can_focus: true, track_hover: true, x_expand: true}), `${title} quota window`);
        const content = new St.BoxLayout({vertical: true, style_class: 'tokengrill-window-card-content'}); root.set_child(content);
        const head = new St.BoxLayout({x_expand: true});
        const name = text(title, 'tokengrill-window-title'); const value = text('Unavailable', 'tokengrill-window-value');
        head.add_child(name); head.add_child(value); content.add_child(head);
        const meter = new St.DrawingArea({height: 6, style_class: 'tokengrill-meter', x_expand: true}); content.add_child(meter);
        const reset = text('No active data', 'tokengrill-secondary'); content.add_child(reset);
        const selected = text('', 'tokengrill-window-selected-label'); content.add_child(selected);
        const card = {root, name, value, meter, reset, selected, window: null, canonical, selectSignalId: 0, repaintSignalId: 0};
        card.selectSignalId = root.connect('clicked', () => this._actions.selectWindow?.(this._instance, canonical));
        card.repaintSignalId = meter.connect('repaint', area => drawMeter(area, card.window?.percent ?? null, pressureColor(card.window)));
        return card;
    }

    _makeCreditsCard() {
        const root = makeShellInteractive(new St.Button({style_class: 'tokengrill-reset-credits', reactive: true, can_focus: true, track_hover: true, x_expand: true}), 'Limit reset credits');
        const content = new St.BoxLayout({style_class: 'tokengrill-reset-credits-content', x_expand: true});
        content.add_child(new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 15, style_class: 'tokengrill-reset-credits-icon'}));
        const labels = new St.BoxLayout({vertical: true, x_expand: true});
        const value = text('Unavailable', 'tokengrill-reset-credits-value'); const expiry = text('', 'tokengrill-secondary');
        labels.add_child(text('LIMIT RESET CREDITS', 'tokengrill-metric-label')); labels.add_child(value); labels.add_child(expiry); content.add_child(labels);
        const chevron = new St.Icon({icon_name: 'pan-end-symbolic', icon_size: 12, style_class: 'tokengrill-secondary'}); content.add_child(chevron); root.set_child(content);
        const details = new St.BoxLayout({vertical: true, style_class: 'tokengrill-reset-credit-details', x_expand: true}); details.hide();
        const clickSignalId = root.connect('clicked', () => { if (!root._available) return; root._expanded = !root._expanded; details.visible = root._expanded; chevron.rotation_angle_z = root._expanded ? 90 : 0; });
        return {root, value, expiry, details, chevron, clickSignalId};
    }

    update(instance: ProviderInstance | null, snapshot: ProviderSnapshot | null, mode = 'remaining', runtime: ProviderRuntimeState | null = null) {
        this._instance = instance;
        this._lastSnapshot = snapshot;
        this._lastMode = mode;
        this._lastRuntime = runtime;
        if (!instance) { this.hide(); return; }
        this.show();
        this._logoBadge.set_child(iconFor(instance, this._basePath, 22));
        this._title.set_text(instance.displayName);
        const metadata = providerMetadata(instance.kind);
        this._subtitle.set_text(`${metadata.label} · ${snapshot?.plan || 'account'}`);
        const state = snapshot?.state || 'unknown';
        this._status.set_text(state === 'ready' ? 'LIVE' : state === 'local' ? 'LOCAL' : state === 'stale' ? 'STALE' : state === 'error' ? 'ERROR' : 'SETUP');
        this._status.set_style_class_name(`tokengrill-status-pill tokengrill-status-${state}`);
        const refresh = runtime?.refresh;
        const busy = ['queued', 'fetching-limits', 'fetching-reset-credits', 'scanning-history'].includes(refresh?.phase);
        const finishedAt = refresh?.completedAt || 0;
        const recentlyFinished = Boolean(finishedAt && Date.now() - finishedAt < 1250);
        this._refreshButton.reactive = !busy;
        this._refreshButton._icon.icon_name = busy ? 'view-refresh-symbolic' : ['failed', 'partial'].includes(refresh?.outcome) && recentlyFinished ? 'dialog-warning-symbolic' : recentlyFinished ? 'object-select-symbolic' : 'view-refresh-symbolic';
        this._refreshButton._icon.icon_size = busy ? 14 : 16;
        this._setSpinning(this._refreshButton._icon, busy);
        if (busy && this._feedbackTimer) {
            GLib.Source.remove(this._feedbackTimer);
            this._feedbackTimer = 0;
        } else if (!busy && recentlyFinished && !this._feedbackTimer) {
            this._feedbackTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ['failed', 'partial'].includes(refresh?.outcome) ? 2000 : 1250, () => {
                this._feedbackTimer = 0;
                if (this._refreshButton && this._instance)
                    this.update(this._instance, this._lastSnapshot, this._lastMode, this._lastRuntime);
                return GLib.SOURCE_REMOVE;
            });
        }
        this._refreshStatus.set_text(busy ? refresh.phase === 'queued' ? 'Queued for refresh…' : refresh.phase === 'scanning-history' ? 'Limits updated · updating history…' : refresh.phase === 'fetching-reset-credits' ? 'Limits updated · checking reset credits…' : 'Refreshing limits…' : refresh?.outcome === 'unchanged' ? `Checked ${clockLabel(refresh.completedAt)} · no change` : refresh?.outcome === 'partial' ? `Quota updated · some sources unavailable` : refresh?.outcome === 'failed' ? `Cached from ${clockLabel(snapshot?.quotaFetchedAt)} · refresh failed` : snapshot?.quotaFetchedAt ? `Updated ${clockLabel(snapshot.quotaFetchedAt)} · ${ageLabel(snapshot.quotaFetchedAt)}` : 'Never refreshed');
        const selection = resolveQuotaSelection(snapshot, instance.panelWindowPreference || 'automatic');
        const selected = selection.selected;
        this._summary.set_style_class_name(`tokengrill-summary tokengrill-pressure-${pressureClass(selected)}`);
        const balance = balanceLabel(snapshot);
        this._summaryValue.set_text(balance || displayLabel(selected, mode));
        const exact = quotaValueLabel(selected);
        this._summaryCaption.set_text(selection.fallbackUsed ? `${instance.panelWindowPreference} selected · showing ${selected?.label || 'available data'} until it returns.` : selected ? `${selected.label}${exact ? ` · ${exact}` : ''} · resets in ${formatResetCountdown(selected.resetAt)}` : 'Waiting for quota data');
        this._summaryReset.set_text(selected?.resetAt ? formatReset(selected.resetAt) : '');
        if (instance.kind === 'deepseek') this._summaryCaption.set_text(balance ? 'Available prepaid balance · no reset schedule' : 'Waiting for balance data');
        const byCanonical = new Map();
        for (const window of snapshot?.windows || []) {
            const previous = byCanonical.get(window.canonicalWindow);
            if (!previous || (window.percent ?? -1) > (previous.percent ?? -1)) byCanonical.set(window.canonicalWindow, window);
        }
        this._updateWindowCard(this._windowCards.fiveHour, byCanonical.get('five-hour') || null, mode, instance.panelWindowPreference === 'five-hour' || (instance.panelWindowPreference === 'automatic' && selected?.canonicalWindow === 'five-hour'));
        this._updateWindowCard(this._windowCards.weekly, byCanonical.get('weekly') || null, mode, instance.panelWindowPreference === 'weekly' || (instance.panelWindowPreference === 'automatic' && selected?.canonicalWindow === 'weekly'));
        this._updateWindowCard(this._windowCards.monthly, byCanonical.get('monthly') || null, mode, instance.panelWindowPreference === 'monthly' || (instance.panelWindowPreference === 'automatic' && selected?.canonicalWindow === 'monthly'));
        for (const card of Object.values(this._windowCards)) card.root.visible = metadata.quotaWindows.includes(card.canonical);
        this._additionalWindows.get_children().forEach(child => child.destroy());
        for (const window of snapshot?.windows || []) {
            if (metadata.quotaWindows.includes(window.canonicalWindow) && byCanonical.get(window.canonicalWindow) === window) continue;
            const row = new St.BoxLayout({vertical: true, style_class: 'tokengrill-window-card', x_expand: true});
            row.add_child(text(`${window.label} · ${displayLabel(window, mode)}`, 'tokengrill-window-value'));
            row.add_child(text(window.resetAt ? formatReset(window.resetAt) : 'Reset time unavailable', 'tokengrill-secondary'));
            this._additionalWindows.add_child(row);
        }
        this._additionalWindows.visible = this._additionalWindows.get_children().length > 0;
        this._updateCredits(snapshot?.resetCredits || null);
        const metrics = historyMetrics(instance, snapshot, runtime);
        for (const [card, metric] of [[this._today, metrics.today], [this._month, metrics.month], [this._cost, metrics.cost]]) {
            card.value.set_text(metric.value);
            card.unit.set_text(metric.unit);
        }
        if (snapshot?.error) {
            const recovery = snapshot.errorInfo?.recovery || 'retry';
            const command = providerMetadata(instance.kind).loginCommand;
            const base = snapshot.errorInfo?.message || snapshot.error || '';
            const needsLogin = recovery === 'reauthenticate' && Boolean(command);
            let directive = '';
            if (needsLogin) {
                if (!/login/i.test(base)) directive = ` ${_('Run')} ${command}.`;
            } else if (recovery === 'edit-provider') {
                directive = ` ${_('Edit the provider in Preferences to resolve this.')}`;
            } else if (recovery === 'retry') {
                directive = ` ${_('Retry when ready.')}`;
            }
            this._errorText.set_text(`${base}${directive}`.trim());
            this._signInButton.visible = needsLogin;
            this._errorRow.show();
        } else {
            this._signInButton.hide();
            this._errorRow.hide();
        }
    }

    _launchLogin() {
        const kind = this._instance?.kind;
        const command = kind ? providerMetadata(kind).loginCommand : null;
        if (!command) return;
        const args = command.split(' ');
        for (const candidate of ['xdg-terminal-exec', 'ptyxis', 'kgx', 'gnome-terminal', 'x-terminal-emulator']) {
            const bin = GLib.find_program_in_path(candidate);
            if (!bin) continue;
            const argv = candidate === 'x-terminal-emulator' ? [bin, '-e', command] : [bin, '--', ...args];
            try {
                Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
                return;
            } catch (error) {
                logError(error, 'Token Grill failed to open the provider sign-in command');
            }
        }
    }

    _updateWindowCard(card, window, mode, selected) {
        card.name.set_text(window?.label || (card.canonical === 'five-hour' ? 'Five-hour' : card.canonical === 'weekly' ? 'Weekly' : 'Monthly'));
        card.window = window; card.root.set_style_class_name(`tokengrill-window-card${selected ? ' tokengrill-window-selected' : ''}`);
        card.value.set_text(window ? displayLabel(window, mode) : 'Unavailable'); card.value.set_style_class_name(`tokengrill-window-value tokengrill-pressure-${pressureClass(window)}`);
        card.reset.set_text(window ? `${quotaValueLabel(window) || formatReset(window.resetAt)} · ${quotaValueLabel(window) ? `${formatReset(window.resetAt)} · ` : ''}resets in ${formatResetCountdown(window.resetAt)}` : 'No active data');
        card.selected.set_text(selected ? 'TOP BAR' : ''); card.root.set_accessible_name(`${card.canonical} quota window${selected ? ', selected for top bar' : ''}${window ? `, ${displayLabel(window, mode)}` : ', unavailable'}`); card.meter.queue_repaint();
    }

    _updateCredits(summary) {
        const supported = Boolean(summary?.supported); this._credits.root.visible = supported; if (!supported) { this._credits.details.hide(); return; }
        const count = summary.availableCount; this._credits.root._available = count !== null && count > 0;
        this._credits.value.set_text(count === null ? 'Unavailable' : count === 0 ? 'No resets available' : `${count} reset${count === 1 ? '' : 's'} available`);
        this._credits.expiry.set_text(summary.stale
            ? `Cached · checked ${summary.fetchedAt ? formatReset(summary.fetchedAt) : 'unknown'}`
            : summary.nextExpiresAt ? `Next expires in ${formatResetCountdown(summary.nextExpiresAt)}` : 'Expiry details unavailable');
        const chevron = this._credits.chevron;
        chevron.visible = Boolean(this._credits.root._available);
        this._credits.details.get_children().forEach(child => child.destroy());
        if (this._credits.root._available && summary.credits?.length && count !== null && count > summary.credits.length) {
            this._credits.details.add_child(text(`${summary.credits.length} of ${count} expiry dates supplied by the provider`, 'tokengrill-reset-credit-disclaimer'));
        }
        if (this._credits.root._available) for (const credit of summary.credits || []) {
            const row = new St.BoxLayout({vertical: true, style_class: 'tokengrill-reset-credit-row'});
            row.add_child(text(credit.title || 'Usage-limit reset', 'tokengrill-window-title'));
            row.add_child(text(credit.expiresAt ? `Expires ${formatReset(credit.expiresAt)} · in ${formatResetCountdown(credit.expiresAt)}` : 'Expiry unavailable', 'tokengrill-secondary')); this._credits.details.add_child(row);
        }
        this._credits.details.visible = Boolean(this._credits.root._expanded && this._credits.root._available);
    }

    _setSpinning(icon, spinning) {
        const existing = icon.get_transition?.('tokengrill-spin');
        if (spinning && !existing && icon.add_transition) {
            icon.set_pivot_point(0.5, 0.5);
            const transition = new Clutter.PropertyTransition({property_name: 'rotation-angle-z'});
            transition.set_from(0); transition.set_to(360); transition.set_duration(900); transition.set_repeat_count(-1);
            icon.add_transition('tokengrill-spin', transition);
        } else if (!spinning && existing) {
            icon.remove_transition('tokengrill-spin'); icon.rotation_angle_z = 0;
        }
    }

    destroy() {
        if (this._feedbackTimer) {
            GLib.Source.remove(this._feedbackTimer);
            this._feedbackTimer = 0;
        }
        for (const card of Object.values(this._windowCards || {})) {
            if (card.selectSignalId) card.root.disconnect(card.selectSignalId);
            if (card.repaintSignalId) card.meter.disconnect(card.repaintSignalId);
            card.selectSignalId = 0;
            card.repaintSignalId = 0;
        }
        if (this._credits?.clickSignalId) this._credits.root.disconnect(this._credits.clickSignalId);
        if (this._credits) this._credits.clickSignalId = 0;
        this._actions = {};
        this._instance = null;
        this._lastSnapshot = null;
        this._lastRuntime = null;
        this._windowCards = null;
        this._credits = null;
        super.destroy();
    }
});

function clockLabel(timestamp) {
    if (!timestamp) return '—';
    const date = GLib.DateTime.new_from_unix_local(Math.round(timestamp / 1000));
    return date ? date.format('%H:%M %Z') : '—';
}

function ageLabel(timestamp) {
    if (!timestamp) return 'never';
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}


function quotaValueLabel(window) {
    if (!window?.unit || !Number.isFinite(window.used)) return '';
    const used = formatQuotaNumber(window.used);
    if (!Number.isFinite(window.limit) || window.limit <= 0) return `${used} ${window.unit} used · pooled or unlimited`;
    return `${used} of ${formatQuotaNumber(window.limit)} ${window.unit} used`;
}

function formatQuotaNumber(value) {
    return Number(value).toLocaleString(undefined, {maximumFractionDigits: 6});
}
