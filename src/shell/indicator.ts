// @ts-nocheck
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {activeProvider} from '../core/display.js';
import type {CanonicalQuotaWindow, PanelDisplayStyle, PanelPercentageMode, ProviderInstance, ProviderRuntimeState, ProviderSnapshot} from '../core/types.js';
import {createPanelDisplay, iconFor, accentColor} from './accountChip.js';
import {ProviderDashboard} from './providerCard.js';
import {makeShellInteractive, resetShellCursor} from './interaction.js';

export interface IndicatorController {
    refreshAll(): void;
    refreshProvider(provider: ProviderInstance): void;
    selectProvider(id: string): void;
    selectQuotaWindow(providerId: string, window: Exclude<CanonicalQuotaWindow, 'other'>): void;
    openPreferences(): void;
    togglePaused(): void;
}

function button(iconName, label, callback, style = 'tokengrill-icon-button') {
    const item = new St.Button({style_class: style, reactive: true, can_focus: true, track_hover: true});
    const content = new St.BoxLayout({style_class: 'tokengrill-button-content'});
    item._icon = new St.Icon({icon_name: iconName, icon_size: 15, style_class: 'system-status-icon'});
    item._label = new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER, style_class: 'tokengrill-button-label'});
    content.add_child(item._icon); content.add_child(item._label); item.set_child(content);
    item.set_accessible_name(label);
    item.connect('clicked', callback);
    return makeShellInteractive(item, label);
}

export const TokenGrillIndicator = GObject.registerClass(class TokenGrillIndicator extends PanelMenu.Button {
    _init(extension: Extension, controller: IndicatorController) {
        super._init(0.5, _('Token Grill'));
        this.extension = extension;
        this.controller = controller;
        this.panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box tokengrill-panel-box'});
        this.add_child(this.panelBox);
        this.cards = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this.cards);
        this.menu.box.add_style_class_name('tokengrill-menu');
        this.menu.box.set_clip_to_allocation(true);
        this.menu.actor.add_style_class_name('tokengrill-boxpointer');
        this.providers = [];
        this.snapshots = new Map();
        this.options = {activeProviderId: '', mode: 'remaining', style: 'text', paused: false};
        this._buildPopover();
    }

    _buildPopover() {
        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tokengrill-popover-item'});
        this._item.set_clip_to_allocation(true);
        this._content = new St.BoxLayout({vertical: true, style_class: 'tokengrill-popover', x_expand: true, clip_to_allocation: true});
        this._header = new St.BoxLayout({style_class: 'tokengrill-popover-header', x_expand: true});
        this._headerTitle = new St.Label({text: _('Token Grill'), style_class: 'tokengrill-footer-brand', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._header.add_child(this._headerTitle);
        this._refreshAllButton = button('view-refresh-symbolic', _('Refresh'), () => this.controller.refreshAll(), 'tokengrill-refresh-all-button');
        this._header.add_child(this._refreshAllButton);
        this._content.add_child(this._header);
        this._tabsScroll = new St.ScrollView({style_class: 'tokengrill-tab-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.NEVER, enable_mouse_scrolling: true, x_expand: true});
        this._tabs = new St.BoxLayout({style_class: 'tokengrill-tabs'}); this._tabsScroll.set_child(this._tabs); this._content.add_child(this._tabsScroll);
        this._dashboard = new ProviderDashboard(this.extension.path, {refresh: provider => this.controller.refreshProvider(provider), selectWindow: (provider, window) => this.controller.selectQuotaWindow(provider.id, window)}); this._content.add_child(this._dashboard);
        this._empty = this._makeEmpty(); this._content.add_child(this._empty);
        const footer = new St.BoxLayout({style_class: 'tokengrill-popover-footer', x_expand: true});
        this._pause = button('media-playback-pause-symbolic', _('Pause'), () => this.controller.togglePaused(), 'tokengrill-footer-button');
        this._pause.x_expand = true;
        this._settingsButton = button('emblem-system-symbolic', _('Preferences'), () => this.controller.openPreferences(), 'tokengrill-footer-button tokengrill-footer-primary');
        this._settingsButton.x_expand = true;
        footer.add_child(this._pause); footer.add_child(this._settingsButton); this._content.add_child(footer);
        this._item.add_child(this._content);
        this.cards.addMenuItem(this._item);
        this._menuStateId = this.menu.connect('open-state-changed', (_menu, open) => { if (!open) resetShellCursor(); });
    }

    _makeEmpty() {
        const empty = new St.BoxLayout({vertical: true, style_class: 'tokengrill-empty-popover', x_expand: true});
        empty.add_child(new St.Icon({gicon: Gio.icon_new_for_string(`${this.extension.path}/token-grill-symbolic.svg`), icon_size: 28, style_class: 'tokengrill-empty-icon'}));
        empty.add_child(new St.Label({text: _('No provider accounts yet'), style_class: 'tokengrill-empty-title'}));
        const settings = makeShellInteractive(new St.Button({label: _('Open Preferences'), style_class: 'tokengrill-link-button', can_focus: true}), _('Open Preferences'));
        this._emptySettingsButton = settings;
        this._emptySettingsSignalId = settings.connect('clicked', () => this.controller.openPreferences());
        empty.add_child(settings);
        return empty;
    }

    update(providers: ProviderInstance[], snapshots: Map<string, ProviderSnapshot>, options = {}) {
        this.providers = providers;
        this.snapshots = snapshots;
        this.options = {...this.options, ...options};
        this._renderPanelSafely();
        this._renderPopoverSafely();
    }

    _renderPanelSafely() {
        try {
            this.panelBox.get_children().forEach(child => child.destroy());
            const current = activeProvider(this.providers, this.options.activeProviderId);
            if (!current) {
                this.panelBox.add_child(new St.Icon({gicon: Gio.icon_new_for_string(`${this.extension.path}/token-grill-symbolic.svg`), icon_size: 16, style_class: 'system-status-icon'}));
                this.panelBox.add_child(new St.Label({text: _('Token Grill'), y_align: Clutter.ActorAlign.CENTER, style_class: 'tokengrill-panel-muted'}));
                this.panelBox.set_accessible_name(_('Token Grill, no provider accounts configured'));
                return;
            }
            const display = createPanelDisplay(current, this.snapshots.get(current.id) || null, this.extension.path, this.options.mode as PanelPercentageMode, this.options.style as PanelDisplayStyle);
            this.panelBox.add_child(display);
        } catch (error) {
            logError(error, 'Token Grill UI panel render failed');
            this.panelBox.get_children().forEach(child => child.destroy());
            this.panelBox.add_child(new St.Label({text: '—', style_class: 'tokengrill-panel-muted'}));
        }
    }

    _renderPopoverSafely() {
        try {
            const enabled = this.providers.filter(provider => provider.enabled);
            const hasProviders = enabled.length > 0;
            this._tabsScroll.visible = hasProviders;
            this._dashboard.visible = hasProviders;
            this._empty.visible = !hasProviders;
            this._pause.visible = hasProviders;
            this._reconcileTabs(enabled);
            const current = activeProvider(this.providers, this.options.activeProviderId) || enabled[0] || null;
            this._dashboard.update(current, current ? this.snapshots.get(current.id) || null : null, this.options.mode, this.options.runtimeStates?.get(current?.id) || null);
            const states = [...(this.options.runtimeStates?.values?.() || [])];
            const busy = states.filter(state => ['queued', 'fetching-limits', 'fetching-reset-credits', 'scanning-history'].includes(state.refresh?.phase));
            this._refreshAllButton.reactive = busy.length === 0;
            this._refreshAllButton._icon.icon_name = 'view-refresh-symbolic';
            const finished = states.filter(state => state.refresh?.completedAt && Date.now() - state.refresh.completedAt < 1500);
            const failed = finished.some(state => state.refresh.outcome === 'failed' || state.refresh.outcome === 'partial');
            this._refreshAllButton._label.set_text(busy.length ? `${busy.length} active` : finished.length ? failed ? _('Partial') : _('Done') : _('Refresh'));
            if (!busy.length && finished.length && !this._refreshFeedbackId) this._refreshFeedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1600, () => { this._refreshFeedbackId = 0; this._refreshAllButton?._label.set_text(_('Refresh')); return GLib.SOURCE_REMOVE; });
            const spin = this._refreshAllButton._icon.get_transition?.('tokengrill-spin');
            if (busy.length && !spin && this._refreshAllButton._icon.add_transition) {
                this._refreshAllButton._icon.set_pivot_point(0.5, 0.5);
                const transition = new Clutter.PropertyTransition({property_name: 'rotation-angle-z'});
                transition.set_from(0); transition.set_to(360); transition.set_duration(900); transition.set_repeat_count(-1);
                this._refreshAllButton._icon.add_transition('tokengrill-spin', transition);
            } else if (!busy.length && spin) {
                this._refreshAllButton._icon.remove_transition('tokengrill-spin'); this._refreshAllButton._icon.rotation_angle_z = 0;
            }
            this._pause._icon.icon_name = this.options.paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
            this._pause._label.set_text(this.options.paused ? _('Resume') : _('Pause'));
        } catch (error) {
            logError(error, 'Token Grill UI popup render failed');
            this._dashboard.update(null, null, this.options.mode);
            this._tabsScroll.visible = false;
        }
    }

    _reconcileTabs(enabled) {
        const wanted = new Set(enabled.map(provider => provider.id));
        for (const child of this._tabs.get_children()) if (!wanted.has(child._providerId)) child.destroy();
        const existing = new Map(this._tabs.get_children().map(child => [child._providerId, child]));
        for (const provider of enabled) {
            let tab = existing.get(provider.id);
            if (!tab) { tab = this._makeTab(provider); this._tabs.add_child(tab); }
            // Keep the tab actor stable while reflecting renamed accounts or
            // changed accents immediately.  Account switching must not cause
            // any collector or filesystem work.
            if (tab._providerKind !== provider.kind) {
                const content = tab.get_child();
                content?.get_children?.().find(child => child._providerIcon)?.destroy();
                const icon = iconFor(provider, this.extension.path, 16);
                icon._providerIcon = true;
                content?.insert_child_at_index(icon, 0);
                tab._providerKind = provider.kind;
            }
            tab._label?.set_text(provider.displayName);
            tab._marker?.set_style(`background-color: ${accentColor(provider)};`);
            const selected = provider.id === activeProvider(this.providers, this.options.activeProviderId)?.id;
            tab.set_style_class_name(`tokengrill-tab${selected ? ' tokengrill-tab-selected' : ''}`);
            tab.set_accessible_name(`${provider.displayName} ${selected ? _('selected') : _('provider tab')}`);
        }
    }

    _makeTab(provider) {
        const tab = makeShellInteractive(new St.Button({style_class: 'tokengrill-tab', reactive: true, can_focus: true, track_hover: true}), `${provider.displayName} provider tab`);
        tab._providerId = provider.id;
        tab._providerKind = provider.kind;
        const content = new St.BoxLayout({style_class: 'tokengrill-tab-content'});
        const icon = iconFor(provider, this.extension.path, 16); icon._providerIcon = true; content.add_child(icon);
        const label = new St.Label({text: provider.displayName, y_align: Clutter.ActorAlign.CENTER, style_class: 'tokengrill-tab-label'}); content.add_child(label);
        const marker = new St.Widget({width: 6, height: 6, y_align: Clutter.ActorAlign.CENTER, style_class: 'tokengrill-tab-marker'}); marker.set_style(`background-color: ${accentColor(provider)};`); content.add_child(marker);
        tab._label = label;
        tab._marker = marker;
        tab.set_child(content); tab.connect('clicked', () => this.controller.selectProvider(provider.id)); return tab;
    }

    destroy() {
        if (this._refreshFeedbackId) {
            GLib.Source.remove(this._refreshFeedbackId);
            this._refreshFeedbackId = 0;
        }
        if (this._menuStateId) {
            this.menu.disconnect(this._menuStateId);
            this._menuStateId = 0;
        }
        if (this._emptySettingsButton && this._emptySettingsSignalId) this._emptySettingsButton.disconnect(this._emptySettingsSignalId);
        this._emptySettingsSignalId = 0;
        this._emptySettingsButton = null;
        this._item?.destroy();
        this._item = null;
        this.cards?.destroy();
        this.cards = null;
        this.controller = null;
        this.extension = null;
        this.providers = [];
        this.snapshots = null;
        this.options = null;
        this.panelBox = null;
        this._dashboard = null;
        resetShellCursor();
        super.destroy();
    }
});
