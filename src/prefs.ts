// @ts-nocheck
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {newProvider, readProviders, writeProviders} from './core/config.js';
import {reorderProviders} from './core/providerOrder.js';
import {defaultHome, displayPath, expandPath, pathExists, providerPaths} from './core/paths.js';
import {providerIconFile, providerMetadata} from './core/providerMetadata.js';
import {firstProviderValidationError, validateProviderDraft} from './core/providerValidation.js';
import {dataPath, statePath} from './storage/atomicJson.js';
import {ACCENTS, PROVIDER_KINDS} from './core/types.js';
import {loadApiKey, loadKimiAuth} from './providers/additional/auth.js';
import {preferencesPageIcon, registerPreferencesIcons} from './prefsIcons.js';
import {tokenFromJwt} from './providers/codex/auth.js';
import {kiroCredentialStatus} from './providers/kiro/auth.js';
import {antigravityCredentialStatus} from './providers/antigravity/auth.js';

const ACCENT_COLORS = {
    blue: '#62a0ea', cyan: '#5bc0eb', green: '#57e389', amber: '#f8e45c',
    orange: '#ff9b42', red: '#ff6b6b', purple: '#c7a0ff', pink: '#f28cb1',
};

function providerIconPath(basePath, kind) {
    return `${basePath}/icons/providers/${providerIconFile(kind)}`;
}

const WINDOW_PREFERENCES = ['automatic', 'five-hour', 'weekly', 'monthly'];
function kindFromIndex(index) { return PROVIDER_KINDS[index] || 'codex'; }
function kindIndex(kind) { const index = PROVIDER_KINDS.indexOf(kind); return index < 0 ? 0 : index; }
function windowIndex(window) { const index = WINDOW_PREFERENCES.indexOf(window); return index < 0 ? 0 : index; }

function pointer(widget) {
    widget.set_cursor_from_name?.('pointer');
    return widget;
}

function labelAccessible(widget, label) {
    widget.update_property?.([Gtk.AccessibleProperty.LABEL], [label]);
    return widget;
}

function providerIcon(basePath, kind, size = 22) {
    const image = Gtk.Image.new_from_gicon(Gio.icon_new_for_string(providerIconPath(basePath, kind)));
    image.set_pixel_size(size);
    image.add_css_class('tokengrill-provider-image');
    return image;
}

function credentialStatus(provider) {
    if (['deepseek', 'opencode', 'kimi'].includes(provider.kind)) return _('Checking credentials…');
    try {
        const paths = providerPaths(provider);
        if (!pathExists(paths.authFile)) return _('Authentication file missing');
        if (provider.kind === 'kiro') return _('Kiro CLI data store found');
        if (provider.kind === 'antigravity') return _('Antigravity credentials found');
        const file = Gio.File.new_for_path(paths.authFile);
        const info = file.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 1024 * 1024)
            return _('Credential file is unreadable');
        const [, bytes] = file.load_contents(null);
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        const oauth = payload.claudeAiOauth && typeof payload.claudeAiOauth === 'object' ? payload.claudeAiOauth : {};
        const token = provider.kind === 'codex' ? payload.tokens?.access_token : oauth.accessToken || payload.sessionKey || payload.oauthToken;
        if (typeof token !== 'string' || !token.trim()) return _('Credential file found; login required');
        if (provider.kind === 'claude' && typeof oauth.expiresAt === 'number') {
            const expiresAt = oauth.expiresAt < 10000000000 ? oauth.expiresAt * 1000 : oauth.expiresAt;
            if (expiresAt <= Date.now()) return _('Credential expired; login required');
        }
        if (provider.kind === 'codex') {
            const expiry = tokenFromJwt(token).expiresAt;
            if (expiry !== null && expiry * 1000 <= Date.now()) return _('Credential expired; login required');
        }
        return _('Authenticated');
    } catch {
        return _('Credential file is unreadable');
    }
}

function historyStatus(provider) {
    if (!providerMetadata(provider.kind).localHistorySupported) return _('Local history unavailable');
    try { return pathExists(providerPaths(provider).sessionsDirectory) ? _('Local history available') : _('No local history directory'); }
    catch { return _('Path needs attention'); }
}

function providerSubtitle(provider, authStatus = credentialStatus(provider)) {
    return `${providerMetadata(provider.kind).label} \u00b7 ${displayPath(provider.accountHome)} \u00b7 ${authStatus} \u00b7 ${historyStatus(provider)}`;
}

function addSection(box, title, description = '') {
    const group = new Adw.PreferencesGroup({title, description});
    box.append(group);
    return group;
}

const ProviderEditorDialog = GObject.registerClass(class ProviderEditorDialog extends Adw.Dialog {
    _init(settings, provider, onSave, onDelete, basePath, parent) {
        super._init({title: provider ? _('Edit provider') : _('Add provider'), content_width: 560, content_height: 680, can_close: true});
        this._settings = settings;
        this._provider = provider;
        this._onSave = onSave;
        this._onDelete = onDelete;
        this._basePath = basePath;
        this._dirty = false;
        this._updatingGeneratedDefaults = false;
        this._nameEdited = Boolean(provider);
        this._homeEdited = Boolean(provider);
        this._accentEdited = Boolean(provider);
        this._build();
        this._dirty = false;
        this.present(parent);
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({show_title: true, show_start_title_buttons: false, show_end_title_buttons: false});
        const close = pointer(new Gtk.Button({icon_name: 'window-close-symbolic', tooltip_text: _('Close')}));
        close.connect('clicked', () => this._requestClose());
        const save = pointer(new Gtk.Button({label: _('Save'), css_classes: ['suggested-action'], tooltip_text: _('Save provider')}));
        save.connect('clicked', () => this._save());
        this._saveButton = save;
        header.pack_start(close);
        header.pack_end(save);
        toolbar.add_top_bar(header);
        const scroll = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vexpand: true});
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 20, margin_bottom: 28, margin_start: 24, margin_end: 24});
        scroll.set_child(content);
        toolbar.set_content(scroll);
        this.set_child(toolbar);

        const identity = addSection(content, _('Identity'), _('Give this account a clear name so it is easy to select in the top bar.'));
        const initialKind = this._provider?.kind || 'codex';
        const initialMetadata = providerMetadata(initialKind);
        this._kind = new Adw.ComboRow({title: _('Provider'), model: Gtk.StringList.new(PROVIDER_KINDS.map(kind => _(providerMetadata(kind).label))), selected: kindIndex(initialKind)});
        this._name = new Adw.EntryRow({title: _('Display name'), text: this._provider?.displayName || initialMetadata.label});
        this._home = new Adw.EntryRow({title: _('Account home'), text: this._provider?.accountHome || displayPath(defaultHome(initialKind))});
        identity.add(this._kind); identity.add(this._name); identity.add(this._home);

        const accent = addSection(content, _('Account accent'), _('Accent colors distinguish multiple accounts without recoloring provider logos.'));
        const swatches = new Gtk.Box({spacing: 6, margin_top: 8, margin_bottom: 8});
        this._accent = this._provider?.accent || providerMetadata(this._provider?.kind || 'codex').defaultAccent;
        for (const color of ACCENTS) {
            const button = pointer(new Gtk.ToggleButton({css_classes: [`tokengrill-accent-${color}`], active: color === this._accent, tooltip_text: `${color} ${_('accent')}`}));
            button.connect('toggled', () => {
                if (!button.active) return;
                this._accent = color;
                if (!this._updatingGeneratedDefaults) {
                    this._accentEdited = true;
                    this._dirty = true;
                }
                for (const child of swatches.get_children()) if (child !== button) child.active = false;
            });
            swatches.append(button);
        }
        accent.add(swatches);

        const collection = addSection(content, _('Collection'));
        this._live = new Adw.SwitchRow({title: _('Live quota'), subtitle: _('Read the provider quota endpoint using this account.'), active: this._provider?.liveUsageEnabled !== false});
        this._history = new Adw.SwitchRow({title: _('Local history'), subtitle: _('Index token accounting without storing prompts or responses.'), active: this._provider?.localHistoryEnabled === true});
        collection.add(this._live); collection.add(this._history);

        const locations = addSection(content, _('Data locations'), _('Paths are local, absolute, or begin with ~/. Advanced overrides are optional.'));
        this._auth = new Adw.EntryRow({title: _('Auth file override'), text: this._provider?.authFileOverride || ''});
        this._sessions = new Adw.EntryRow({title: _('Sessions directory override'), text: this._provider?.sessionsDirectoryOverride || ''});
        const advanced = new Adw.ExpanderRow({title: _('Advanced path overrides'), subtitle: _('Use only for nonstandard installations.')});
        advanced.add_row(this._auth); advanced.add_row(this._sessions); locations.add(advanced);
        this._resolved = new Adw.ActionRow({title: _('Resolved paths'), subtitle: ''});
        locations.add(this._resolved);
        this._home.connect('notify::text', () => { if (!this._updatingGeneratedDefaults) this._homeEdited = true; this._dirty = true; this._updateResolved(); this._validate(); });
        this._auth.connect('notify::text', () => { this._dirty = true; this._updateResolved(); this._validate(); });
        this._sessions.connect('notify::text', () => { this._dirty = true; this._updateResolved(); this._validate(); });
        this._updateResolved();

        const panel = addSection(content, _('Panel display'));
        this._showPanel = new Adw.SwitchRow({title: _('Show in top bar'), subtitle: _('Use this account as a selectable top-bar tab.'), active: this._provider?.showInPanel !== false});
        this._windowPreference = new Adw.ComboRow({title: _('Quota window'), subtitle: _('Choose the limit that drives this account\u2019s panel reading.'), model: Gtk.StringList.new([_('Automatic'), _('Five-hour'), _('Weekly'), _('Monthly')]), selected: windowIndex(this._provider?.panelWindowPreference || 'automatic')});
        panel.add(this._showPanel); panel.add(this._windowPreference);

        if (this._provider) {
            const removal = addSection(content, _('Remove provider'), _('Provider credentials, sessions, and files are never changed.'));
            const remove = pointer(new Gtk.Button({label: _('Delete provider'), css_classes: ['destructive-action'], halign: Gtk.Align.FILL, hexpand: true, margin_top: 8, margin_bottom: 8}));
            remove.connect('clicked', () => this._confirmDelete());
            removal.add(remove);
        }
        this._name.connect('notify::text', () => { if (!this._updatingGeneratedDefaults) this._nameEdited = true; this._dirty = true; this._validate(); });
        this._kind.connect('notify::selected', () => {
            const kind = kindFromIndex(this._kind.selected);
            const metadata = providerMetadata(kind);
            if (!this._provider) {
                this._updatingGeneratedDefaults = true;
                if (!this._nameEdited) this._name.text = metadata.label;
                if (!this._homeEdited) this._home.text = displayPath(defaultHome(kind));
                if (!this._accentEdited) {
                    this._accent = metadata.defaultAccent;
                    for (const child of swatches.get_children()) child.active = child.get_css_classes().includes(`tokengrill-accent-${this._accent}`);
                }
                this._updatingGeneratedDefaults = false;
            }
            this._updateCapabilities(); this._updateResolved(); this._dirty = true; this._validate();
        });
        this._windowPreference.connect('notify::selected', () => { this._dirty = true; this._validate(); });
        for (const widget of [this._showPanel, this._live, this._history]) widget.connect('notify::active', () => { this._dirty = true; this._validate(); });
        this._updateCapabilities(); this._validate();
    }

    _updateCapabilities() {
        const kind = kindFromIndex(this._kind.selected);
        const metadata = providerMetadata(kind);
        if (!metadata.localHistorySupported) this._history.active = false;
        this._history.sensitive = metadata.localHistorySupported;
        this._history.subtitle = metadata.localHistorySupported ? _('Index token accounting without storing prompts or responses.') : _(`${metadata.label} local history is not supported; live quota remains available.`);
        if (metadata.quotaWindows.length === 1) this._windowPreference.selected = windowIndex(metadata.defaultQuotaWindow);
        this._windowPreference.sensitive = metadata.quotaWindows.length > 1;
        this._sessions.sensitive = metadata.localHistorySupported;
        this._live.title = kind === 'deepseek' ? _('Live balance') : _('Live quota');
        this._live.subtitle = kind === 'deepseek' ? _('Read your prepaid API balance using the DeepSeek key in OpenCode auth.json or a JSON API key file.') : kind === 'opencode' ? _('Read Go subscription quotas. Zen pay-as-you-go balance is not exposed by this API.') : kind === 'kimi' ? _('Read Kimi Code subscription quotas using your CLI login. Run /login inside kimi when credentials expire.') : _('Read the provider quota endpoint using this account.');
        if (!metadata.quotaWindows.length) this._windowPreference.selected = 0;
    }

    _updateResolved() {
        try {
            const draft = this._provider ? {...this._provider} : newProvider(kindFromIndex(this._kind?.selected), this._home.text);
            draft.kind = kindFromIndex(this._kind?.selected);
            draft.accountHome = expandPath(this._home.text);
            draft.authFileOverride = this._auth?.text ? expandPath(this._auth.text) : null;
            draft.sessionsDirectoryOverride = this._sessions?.text ? expandPath(this._sessions.text) : null;
            const paths = providerPaths(draft);
            this._resolved.subtitle = `${displayPath(paths.authFile)} \u00b7 ${displayPath(paths.sessionsDirectory)}`;
            if (draft.kind === 'kimi' && !draft.authFileOverride) this._resolved.subtitle = `${displayPath(paths.configFile)} · credentials selected by configuration`;
        } catch (error) { this._resolved.subtitle = error.message; }
    }

    _validate() {
        const kind = kindFromIndex(this._kind?.selected);
        const draft = this._provider ? {...this._provider} : newProvider(kind, this._home?.text || '');
        draft.kind = kind;
        draft.displayName = this._name?.text || '';
        draft.accountHome = this._home?.text || '';
        draft.authFileOverride = this._auth?.text || null;
        draft.sessionsDirectoryOverride = this._sessions?.text || null;
        const result = validateProviderDraft(draft, readProviders(this._settings), expandPath);
        this._name.subtitle = result.errors.displayName ? _(result.errors.displayName) : '';
        this._home.subtitle = result.errors.accountHome ? _(result.errors.accountHome) : '';
        this._auth.subtitle = result.errors.authFileOverride ? _(result.errors.authFileOverride) : '';
        this._sessions.subtitle = result.errors.sessionsDirectoryOverride ? _(result.errors.sessionsDirectoryOverride) : '';
        this._saveButton.sensitive = result.valid;
        this._saveButton.tooltip_text = result.valid ? _('Save provider') : _(firstProviderValidationError(result));
        return result.valid;
    }

    _save() {
        try {
            if (!this._validate()) return;
            const value = this._provider || newProvider(kindFromIndex(this._kind.selected), this._home.text);
            value.schemaVersion = 2;
            value.kind = kindFromIndex(this._kind.selected);
            value.displayName = this._name.text.trim() || value.kind;
            value.accountHome = expandPath(this._home.text);
            value.authFileOverride = this._auth.text.trim() ? expandPath(this._auth.text) : null;
            value.sessionsDirectoryOverride = this._sessions.text.trim() ? expandPath(this._sessions.text) : null;
            value.accent = this._accent;
            value.enabled = value.enabled !== false;
            value.showInPanel = this._showPanel.active;
            value.liveUsageEnabled = this._live.active;
            value.localHistoryEnabled = providerMetadata(value.kind).localHistorySupported && this._history.active;
            value.panelWindowPreference = providerMetadata(value.kind).quotaWindows.length === 1 ? providerMetadata(value.kind).defaultQuotaWindow : WINDOW_PREFERENCES[this._windowPreference.selected] || 'automatic';
            this._onSave(value);
            this._dirty = false;
            this.close();
        } catch (error) {
            this._name.subtitle = error.message;
        }
    }

    _requestClose() {
        if (!this._dirty) { this.close(); return; }
        const dialog = new Adw.AlertDialog({heading: _('Discard changes?'), body: _('Your provider changes have not been saved.')});
        dialog.add_response('cancel', _('Keep editing')); dialog.add_response('discard', _('Discard')); dialog.set_response_appearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this, null, (_dialog, result) => { if (_dialog.choose_finish(result) === 'discard') { this._dirty = false; this.close(); } });
    }

    _confirmDelete() {
        const dialog = new Adw.AlertDialog({
            heading: _('Delete provider?'),
            body: _('This removes the provider\u2019s Token Grill configuration and collected aggregates. Provider credentials, sessions, and files are untouched.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('delete', _('Delete'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this, null, (_dialog, result) => {
            if (_dialog.choose_finish(result) !== 'delete') return;
            this._dirty = false;
            this.close();
            this._onDelete(this._provider.id);
        });
    }
});

const ProviderReorderDialog = GObject.registerClass(class ProviderReorderDialog extends Adw.Dialog {
    _init(providers, onSave, basePath, parent) {
        super._init({title: _('Reorder providers'), content_width: 520, content_height: 560, can_close: true});
        this._providers = reorderProviders(providers, providers.map(provider => provider.id));
        this._onSave = onSave;
        this._basePath = basePath;

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        const cancel = pointer(new Gtk.Button({label: _('Cancel')}));
        cancel.connect('clicked', () => this.close());
        const save = pointer(new Gtk.Button({label: _('Save'), css_classes: ['suggested-action']}));
        save.connect('clicked', () => { this._onSave(reorderProviders(this._providers, this._providers.map(provider => provider.id))); this.close(); });
        header.pack_start(cancel); header.pack_end(save); toolbar.add_top_bar(header);

        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 18, margin_bottom: 24, margin_start: 24, margin_end: 24});
        content.append(new Gtk.Label({label: _('Drag accounts, or use the arrow buttons, to choose their order in Preferences and the Token Grill popup.'), wrap: true, xalign: 0}));
        this._list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        content.append(this._list);
        const scroll = new Gtk.ScrolledWindow({vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER});
        scroll.set_child(content); toolbar.set_content(scroll); this.set_child(toolbar);
        this._render();
        this.present(parent);
    }

    _render() {
        while (this._list.get_first_child()) this._list.remove(this._list.get_first_child());
        this._providers.forEach((provider, index) => {
            const row = new Adw.ActionRow({title: provider.displayName, subtitle: provider.enabled ? providerMetadata(provider.kind).label : `${providerMetadata(provider.kind).label} \u00b7 ${_('Disabled')}`});
            row.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic', tooltip_text: _('Drag to reorder')}));
            row.add_prefix(providerIcon(this._basePath, provider.kind));
            const upLabel = `${_('Move up')} ${provider.displayName}`;
            const up = labelAccessible(pointer(new Gtk.Button({icon_name: 'go-up-symbolic', tooltip_text: upLabel, css_classes: ['flat'], valign: Gtk.Align.CENTER, sensitive: index > 0})), upLabel);
            const downLabel = `${_('Move down')} ${provider.displayName}`;
            const down = labelAccessible(pointer(new Gtk.Button({icon_name: 'go-down-symbolic', tooltip_text: downLabel, css_classes: ['flat'], valign: Gtk.Align.CENTER, sensitive: index < this._providers.length - 1})), downLabel);
            up.connect('clicked', () => this._move(provider.id, index - 1));
            down.connect('clicked', () => this._move(provider.id, index + 1));
            row.add_suffix(up); row.add_suffix(down);

            const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
            drag.connect('prepare', () => Gdk.ContentProvider.new_for_value(provider.id));
            row.add_controller(drag);
            const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
            drop.connect('drop', (_target, draggedId, _x, y) => {
                this._drop(String(draggedId), provider.id, y > row.get_height() / 2);
                return true;
            });
            row.add_controller(drop);
            this._list.append(row);
        });
    }

    _move(providerId, requestedIndex) {
        const index = this._providers.findIndex(provider => provider.id === providerId);
        if (index < 0) return;
        const next = [...this._providers];
        const [provider] = next.splice(index, 1);
        const target = Math.max(0, Math.min(next.length, requestedIndex));
        next.splice(target, 0, provider);
        this._providers = reorderProviders(next, next.map(item => item.id));
        this._render();
    }

    _drop(providerId, targetId, after) {
        if (providerId === targetId) return;
        const next = this._providers.filter(provider => provider.id !== providerId);
        const provider = this._providers.find(item => item.id === providerId);
        const targetIndex = next.findIndex(item => item.id === targetId);
        if (!provider || targetIndex < 0) return;
        next.splice(targetIndex + (after ? 1 : 0), 0, provider);
        this._providers = reorderProviders(next, next.map(item => item.id));
        this._render();
    }
});

const ProvidersPage = GObject.registerClass(class ProvidersPage extends Adw.PreferencesPage {
    _init(settings, window, basePath) { super._init({title: _('Providers'), icon_name: preferencesPageIcon('system-users-symbolic', 'tokengrill-providers-symbolic')}); this._settings = settings; this._window = window; this._basePath = basePath; this._groups = []; this._render(); }
    _render() {
        for (const group of this._groups) this.remove(group);
        this._groups = [];
        const providers = readProviders(this._settings);
        const headerGroup = new Adw.PreferencesGroup();
        const headerRow = new Adw.ActionRow({title: _('Providers'), subtitle: _('Choose which accounts appear in Token Grill.')});
        const headerActions = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER});
        const reorder = pointer(new Gtk.Button({label: _('Reorder'), sensitive: providers.length >= 2})); reorder.connect('clicked', () => this._reorder(providers));
        const discoverHeader = pointer(new Gtk.Button({label: _('Discover')})); discoverHeader.connect('clicked', () => this._discover());
        const addHeader = pointer(new Gtk.Button({label: _('Add provider'), css_classes: ['suggested-action']})); addHeader.connect('clicked', () => this._edit(null));
        headerActions.append(reorder); headerActions.append(discoverHeader); headerActions.append(addHeader); headerRow.add_suffix(headerActions); headerGroup.add(headerRow);
        this.add(headerGroup); this._groups.push(headerGroup);
        const group = new Adw.PreferencesGroup({title: _('Configured accounts'), description: _('Click an account to edit it. Switch accounts directly from the Token Grill popup.')});
        for (const provider of providers) {
            const row = pointer(new Adw.ActionRow({title: provider.displayName, subtitle: providerSubtitle(provider), activatable: true}));
            if (provider.kind === 'kiro') kiroCredentialStatus(provider).then(status => {
                const label = status === 'authenticated' ? _('Authenticated') : status === 'expired-refreshable' ? _('Credential expired but refreshable') : status === 'login-required' ? _('Login required') : status === 'dependency-missing' ? _('Missing Gda 5.0 dependency') : _('Database unreadable');
                row.subtitle = providerSubtitle(provider, label);
            }).catch(() => { row.subtitle = providerSubtitle(provider, _('Database unreadable')); });
            if (provider.kind === 'antigravity') antigravityCredentialStatus(provider).then(status => {
                const label = status === 'authenticated' ? _('Authenticated') : status === 'expired-refreshable' ? _('Credential expired but refreshable') : status === 'login-required' ? _('Login required') : _('Credential unreadable');
                row.subtitle = providerSubtitle(provider, label);
            }).catch(() => { row.subtitle = providerSubtitle(provider, _('Credential unreadable')); });
            if (['deepseek', 'opencode', 'kimi'].includes(provider.kind)) {
                const cancellable = new Gio.Cancellable();
                row.connect('destroy', () => cancellable.cancel());
                const auth = provider.kind === 'kimi' ? loadKimiAuth(provider, cancellable) : loadApiKey(provider, cancellable);
                auth.then(() => { if (!cancellable.is_cancelled()) row.subtitle = providerSubtitle(provider, _('Authenticated')); })
                    .catch(error => { if (!cancellable.is_cancelled()) row.subtitle = providerSubtitle(provider, error.message); });
            }
            row.add_prefix(providerIcon(this._basePath, provider.kind));
            const enabled = pointer(new Gtk.Switch({active: provider.enabled, valign: Gtk.Align.CENTER}));
            enabled.set_tooltip_text(_('Enable collection'));
            enabled.connect('state-set', (_switch, state) => { provider.enabled = state; writeProviders(this._settings, providers); return false; });
            row.add_suffix(enabled);
            const editLabel = `${_('Edit')} ${provider.displayName}`;
            const edit = labelAccessible(pointer(new Gtk.Button({icon_name: 'emblem-system-symbolic', valign: Gtk.Align.CENTER, tooltip_text: editLabel, css_classes: ['flat'], width_request: 42, height_request: 42})), editLabel);
            edit.connect('clicked', () => this._edit(provider));
            row.add_suffix(edit);
            row.connect('activated', () => this._edit(provider));
            group.add(row);
        }
        this.add(group); this._groups.push(group);
    }
    _edit(provider) {
        const save = value => { const providers = readProviders(this._settings); const index = providers.findIndex(item => item.id === value.id); if (index >= 0) providers[index] = value; else { value.sortOrder = providers.length; providers.push(value); } writeProviders(this._settings, reorderProviders(providers, providers.map(item => item.id))); this._render(); };
        const remove = providerId => { const providers = readProviders(this._settings).filter(item => item.id !== providerId); writeProviders(this._settings, reorderProviders(providers, providers.map(item => item.id))); this._render(); };
        new ProviderEditorDialog(this._settings, provider, save, remove, this._basePath, this._window);
    }
    _reorder(providers) {
        new ProviderReorderDialog(providers, ordered => { writeProviders(this._settings, ordered); this._render(); }, this._basePath, this._window);
    }
    async _discover() {
        const providers = readProviders(this._settings); const home = Gio.File.new_for_path(GLib.get_home_dir()); const found = []; let candidates = 0;
        const enumerator = home.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null); let info;
        while ((info = enumerator.next_file(null))) {
            const name = info.get_name(); if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
            const kind = name.startsWith('.codex') ? 'codex' : name.startsWith('.claude') ? 'claude' : null; if (!kind) continue;
            const path = `~/${name}`; const candidate = newProvider(kind, path); const paths = providerPaths(candidate);
            if (!pathExists(paths.authFile) && !pathExists(paths.sessionsDirectory)) continue;
            candidates++;
            if (providers.some(item => expandPath(item.accountHome) === expandPath(path))) continue;
            candidate.displayName = `${kind[0].toUpperCase()}${kind.slice(1)}${name.slice(kind === 'codex' ? 6 : 7)}`;
            found.push(candidate);
        }
        const kiroHome = defaultHome('kiro');
        const kiro = newProvider('kiro', kiroHome);
        if (pathExists(providerPaths(kiro).authFile)) {
            candidates++;
            if (![...providers, ...found].some(item => expandPath(item.accountHome) === expandPath(kiroHome))) found.push(kiro);
        }

        const antigravityHomes = [
            defaultHome('antigravity'),
            GLib.build_filenamev([GLib.get_home_dir(), '.gemini', 'antigravity']),
            GLib.build_filenamev([GLib.get_home_dir(), '.config', 'Antigravity']),
        ];
        try {
            const t3Dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), '.t3', 'userdata', 'providers', 'antigravity']));
            if (t3Dir.query_exists(null)) {
                const t3Enum = t3Dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
                let t3Info;
                while ((t3Info = t3Enum.next_file(null))) {
                    if (t3Info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
                    antigravityHomes.push(GLib.build_filenamev([GLib.get_home_dir(), '.t3', 'userdata', 'providers', 'antigravity', t3Info.get_name(), 'antigravity-acp']));
                }
            }
        } catch { /* ignore discovery errors */ }

        for (const agyHome of antigravityHomes) {
            const agy = newProvider('antigravity', agyHome);
            const paths = providerPaths(agy);
            if (pathExists(paths.authFile)) {
                candidates++;
                if (![...providers, ...found].some(item => expandPath(item.accountHome) === expandPath(agyHome))) {
                    found.push(agy);
                }
            }
        }

        for (const kind of ['deepseek', 'opencode', 'kimi']) {
            const candidate = newProvider(kind, defaultHome(kind));
            try {
                const cancellable = new Gio.Cancellable();
                if (kind === 'kimi') await loadKimiAuth(candidate, cancellable);
                else await loadApiKey(candidate, cancellable);
                candidates++;
                if (![...providers, ...found].some(item => item.kind === kind && expandPath(item.accountHome) === expandPath(candidate.accountHome))) found.push(candidate);
            } catch { /* An unconfigured provider is not a discovery candidate. */ }
        }

        if (!found.length) {
            const heading = candidates ? _('All discovered accounts are already configured') : _('No new accounts found');
            const body = candidates ? _('The discovered account homes are already in Token Grill.') : _('Token Grill checked Codex, Claude, Kiro, Antigravity, Kimi Code, and OpenCode credentials for configured accounts.');
            const dialog = new Adw.AlertDialog({heading, body}); dialog.add_response('close', _('Close')); dialog.present(this._window); return;
        }
        const dialog = new Adw.Dialog({title: _('Discover accounts'), content_width: 520, content_height: 520});
        const toolbar = new Adw.ToolbarView(); const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        const close = pointer(new Gtk.Button({icon_name: 'window-close-symbolic', tooltip_text: _('Cancel')})); close.connect('clicked', () => dialog.close()); header.pack_start(close); toolbar.add_top_bar(header);
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14, margin_top: 20, margin_bottom: 20, margin_start: 24, margin_end: 24});
        content.append(new Gtk.Label({label: _('Select the accounts Token Grill should monitor.'), xalign: 0, wrap: true}));
        const checks = found.map(item => { const row = pointer(new Gtk.CheckButton({label: `${item.displayName}  \u00b7  ${displayPath(item.accountHome)}`, active: true})); content.append(row); return row; });
        const add = pointer(new Gtk.Button({label: _('Add selected accounts'), css_classes: ['suggested-action'], halign: Gtk.Align.END}));
        add.connect('clicked', () => { const selected = found.filter((_item, index) => checks[index].active); if (!selected.length) return; writeProviders(this._settings, [...providers, ...selected.map((item, index) => ({...item, sortOrder: providers.length + index}))]); dialog.close(); this._render(); });
        content.append(add); const scroll = new Gtk.ScrolledWindow({vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER}); scroll.set_child(content); toolbar.set_content(scroll); dialog.set_child(toolbar); dialog.present(this._window);
    }
});

const GeneralPage = GObject.registerClass(class GeneralPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: _('General'), icon_name: preferencesPageIcon('preferences-system-symbolic', 'tokengrill-general-symbolic')}); this._settings = settings;
        const appearance = new Adw.PreferencesGroup({title: _('Panel appearance'), description: _('Choose what the active provider looks like in the top bar.')});
        const mode = new Adw.ComboRow({title: _('Percentage'), model: Gtk.StringList.new([_('Remaining'), _('Used')]), selected: settings.get_string('panel-percentage-mode') === 'used' ? 1 : 0}); mode.connect('notify::selected', () => settings.set_string('panel-percentage-mode', mode.selected === 1 ? 'used' : 'remaining'));
        const style = new Adw.ComboRow({title: _('Panel style'), model: Gtk.StringList.new([_('Icon + percentage'), _('Circular meter'), _('Linear meter')]), selected: settings.get_string('panel-display-style') === 'ring' ? 1 : settings.get_string('panel-display-style') === 'bar' ? 2 : 0}); style.connect('notify::selected', () => settings.set_string('panel-display-style', style.selected === 1 ? 'ring' : style.selected === 2 ? 'bar' : 'text'));
        appearance.add(mode); appearance.add(style); this.add(appearance);
        const panelGroup = new Adw.PreferencesGroup({title: _('Panel accounts')});
        const allAccounts = new Adw.SwitchRow({title: _('Show all accounts'), subtitle: _('Show a chip for every account in the top bar instead of only the active one.'), active: settings.get_boolean('panel-show-all-accounts')});
        settings.bind('panel-show-all-accounts', allAccounts, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(allAccounts); this.add(panelGroup);
        const refreshGroup = new Adw.PreferencesGroup({title: _('Refresh and storage')});
        for (const [key, title, lower, upper, step] of [['refresh-interval-seconds', _('Refresh interval'), 60, 3600, 60]]) { const row = new Adw.SpinRow({title, adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, value: settings.get_uint(key)} )}); settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT); refreshGroup.add(row); }
        this.add(refreshGroup);
        const behavior = new Adw.PreferencesGroup({title: _('Session behavior')});
        const pause = new Adw.SwitchRow({title: _('Pause while session is locked'), active: settings.get_boolean('pause-when-session-locked')}); settings.bind('pause-when-session-locked', pause, 'active', Gio.SettingsBindFlags.DEFAULT); behavior.add(pause); this.add(behavior);
    }
});

const NotificationsPage = GObject.registerClass(class NotificationsPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: _('Notifications'), icon_name: preferencesPageIcon('preferences-system-notifications-symbolic', 'tokengrill-notifications-symbolic')});
        this._settings = settings;
        const group = new Adw.PreferencesGroup({title: _('Quota alerts'), description: _('Each account sends at most one alert when its selected limit crosses a usage step.')});
        const enabled = new Adw.SwitchRow({title: _('Usage notifications'), subtitle: _('Track the same Five-hour, Weekly, Monthly, or automatic limit selected for that account.'), active: settings.get_boolean('notifications-enabled')});
        settings.bind('notifications-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        const step = new Adw.SpinRow({title: _('Notify every'), subtitle: _('Notify once when the selected limit crosses each additional usage step.'), adjustment: new Gtk.Adjustment({lower: 5, upper: 50, step_increment: 5, value: settings.get_uint('notification-step-percent')}), digits: 0});
        settings.bind('notification-step-percent', step, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled); group.add(step); this.add(group);

        this._preview = new Adw.PreferencesGroup({title: _('Test notification'), description: _('Preview the selected account\u2019s current notification style. This does not change milestone tracking.')});
        this.add(this._preview);
        this._renderPreview();
        this._providerSettingsId = settings.connect('changed::provider-instances-json', () => this._renderPreview());
        this._activeSettingsId = settings.connect('changed::active-provider-id', () => this._renderPreview());
        this.connect('destroy', () => {
            if (this._providerSettingsId) settings.disconnect(this._providerSettingsId);
            if (this._activeSettingsId) settings.disconnect(this._activeSettingsId);
            this._providerSettingsId = 0;
            this._activeSettingsId = 0;
        });
    }

    _renderPreview() {
        if (this._account) this._preview.remove(this._account);
        if (this._sendRow) this._preview.remove(this._sendRow);
        const providers = readProviders(this._settings);
        const activeId = this._settings.get_string('active-provider-id');
        const activeIndex = providers.findIndex(provider => provider.id === activeId);
        this._account = new Adw.ComboRow({
            title: _('Account'),
            model: Gtk.StringList.new(providers.map(provider => provider.enabled ? provider.displayName : `${provider.displayName} (${_('disabled')})`)),
            selected: activeIndex >= 0 ? activeIndex : 0,
            sensitive: providers.length > 0,
        });
        this._sendRow = new Adw.ActionRow({title: _('Send test notification'), subtitle: _('Works even when automatic usage notifications are off.')});
        const send = pointer(new Gtk.Button({label: _('Send test'), css_classes: ['suggested-action'], valign: Gtk.Align.CENTER, sensitive: providers.length > 0}));
        send.connect('clicked', () => {
            const provider = providers[this._account.selected];
            if (!provider) return;
            this._settings.set_string('notification-test-request', JSON.stringify({providerId: provider.id, nonce: GLib.uuid_string_random()}));
        });
        this._sendRow.add_suffix(send);
        this._preview.add(this._account);
        this._preview.add(this._sendRow);
    }
});

const DataPage = GObject.registerClass(class DataPage extends Adw.PreferencesPage {
    _init() { super._init({title: _('Data'), icon_name: 'folder-symbolic'}); const group = new Adw.PreferencesGroup({title: _('Local data'), description: _('Only compact aggregates and checkpoints are stored. Provider logs are never modified.')}); group.add(new Adw.ActionRow({title: _('Usage history'), subtitle: displayPath(dataPath('history-v1.json'))})); group.add(new Adw.ActionRow({title: _('Parser checkpoints'), subtitle: displayPath(statePath('checkpoints-v1.json'))})); this.add(group); }
});

export default class TokenGrillPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        registerPreferencesIcons(this.path);
        const settings = this.getSettings(); window.set_default_size(760, 700); window.add_css_class('tokengrill-preferences');
        const css = new Gtk.CssProvider(); css.load_from_path(`${this.path}/prefs.css`); const display = Gdk.Display.get_default(); if (display) Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        window.add(new GeneralPage(settings)); window.add(new ProvidersPage(settings, window, this.path)); window.add(new NotificationsPage(settings)); window.add(new DataPage());
    }
}
