import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {PROVIDERS_KEY, readProviders, writeProviders} from '../core/config.js';
import {isCancellation} from '../core/gio.js';
import {formatText} from '../core/i18n.js';
import {providerMetadata} from '../core/providerMetadata.js';
import {reorderProviders} from '../core/providerOrder.js';
import {topBarSummary} from '../core/topBar.js';
import type {ProviderInstance, ProviderKind} from '../core/types.js';
import {AccountPage} from './accountPage.js';
import {AddAccountDialog} from './addAccountDialog.js';
import {credentialLabel, credentialState} from './credentialStatus.js';
import {DiscoverDialog} from './discoverDialog.js';
import {ReorderDialog} from './reorderDialog.js';
import {TRANSLATOR} from './translator.js';
import {providerIcon, setAccessibleLabel} from './widgets.js';

// Accounts of one service stay together even when the saved order interleaves them.
function byService(providers: ProviderInstance[]): Array<[ProviderKind, ProviderInstance[]]> {
    const groups = new Map<ProviderKind, ProviderInstance[]>();
    for (const provider of providers) {
        const accounts = groups.get(provider.kind) ?? [];
        accounts.push(provider);
        groups.set(provider.kind, accounts);
    }
    return [...groups];
}

function accountSubtitle(provider: ProviderInstance, status: string): string {
    const parts = [topBarSummary(TRANSLATOR, provider.topBar), status];
    if (provider.app === 'opencode')
        parts.unshift(_('via OpenCode'));
    return parts.reduce((left, right) => formatText(_('%s - %s'), left, right));
}

export class AccountsPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillAccountsPage'}, this);
    }

    private readonly _settings: Gio.Settings;
    private readonly _window: Adw.PreferencesWindow;
    private readonly _extensionPath: string;
    private _groups: Adw.PreferencesGroup[] = [];
    private _cancellable = new Gio.Cancellable();
    // The stored accounts the page shows, so its own writes do not rebuild it.
    private _shown = '';

    constructor(settings: Gio.Settings, window: Adw.PreferencesWindow, extensionPath: string) {
        super({title: _('Accounts'), icon_name: 'system-users-symbolic'});
        this._settings = settings;
        this._window = window;
        this._extensionPath = extensionPath;
        // The popup changes what each account shows in the top bar while this window is open.
        const changedId = settings.connect(`changed::${PROVIDERS_KEY}`, () => {
            if (settings.get_string(PROVIDERS_KEY) !== this._shown)
                this._render();
        });
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            this._cancellable.cancel();
            return false;
        });
        this._render();
    }

    private _render(): void {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        for (const group of this._groups)
            this.remove(group);
        this._shown = this._settings.get_string(PROVIDERS_KEY);

        const providers = readProviders(this._settings);
        const header = new Adw.PreferencesGroup({
            title: _('Accounts'),
            description: _('Top-bar limits are chosen in the popup'),
            header_suffix: this._buildHeaderActions(providers),
        });
        if (!providers.length) {
            header.add(new Adw.ActionRow({
                title: _('No Accounts Yet'),
                subtitle: _('Add one, or use Discover to find accounts already signed in'),
            }));
        }
        this._groups = [header];
        for (const [kind, accounts] of byService(providers)) {
            const group = new Adw.PreferencesGroup({title: providerMetadata(kind).label});
            for (const provider of accounts)
                group.add(this._buildRow(provider));
            this._groups.push(group);
        }
        for (const group of this._groups)
            this.add(group);
    }

    private _buildHeaderActions(providers: ProviderInstance[]): Gtk.Box {
        const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        const reorder = new Gtk.Button({label: _('Reorder...'), css_classes: ['flat'], sensitive: providers.length >= 2});
        reorder.connect('clicked', () => this._reorder());
        box.append(reorder);
        const discover = new Gtk.Button({
            label: _('Discover...'),
            css_classes: ['flat'],
            tooltip_text: _('Find accounts already signed in on this computer'),
        });
        discover.connect('clicked', () => this._discover());
        box.append(discover);
        const add = new Gtk.Button({label: _('Add Account...'), css_classes: ['suggested-action']});
        add.connect('clicked', () => this._add());
        box.append(add);
        return box;
    }

    private _buildRow(provider: ProviderInstance): Adw.ActionRow {
        const row = new Adw.ActionRow({
            title: provider.displayName,
            subtitle: accountSubtitle(provider, _('Checking credentials...')),
            activatable: true,
        });
        const cancellable = this._cancellable;
        credentialState(provider, cancellable).then(state => {
            if (!cancellable.is_cancelled())
                row.subtitle = accountSubtitle(provider, credentialLabel(state));
        }).catch(error => {
            if (!isCancellation(error))
                logError(error, 'Token Grill');
        });
        row.add_prefix(providerIcon(this._extensionPath, provider.kind));

        const enabledLabel = formatText(_('Collect usage for %s'), provider.displayName);
        const enabled = new Gtk.Switch({active: provider.enabled, valign: Gtk.Align.CENTER, tooltip_text: enabledLabel});
        setAccessibleLabel(enabled, enabledLabel);
        enabled.connect('notify::active', () => this._setEnabled(provider.id, enabled.active));
        row.add_suffix(enabled);
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        row.connect('activated', () => this._edit(provider));
        return row;
    }

    private _write(providers: ProviderInstance[]): void {
        writeProviders(this._settings, providers);
        this._shown = this._settings.get_string(PROVIDERS_KEY);
    }

    private _setEnabled(providerId: string, enabled: boolean): void {
        this._write(readProviders(this._settings).map(provider =>
            provider.id === providerId ? {...provider, enabled} : provider));
    }

    private _persist(providers: ProviderInstance[]): void {
        this._write(reorderProviders(providers, providers.map(provider => provider.id)));
        this._render();
    }

    private _add(): void {
        const providers = readProviders(this._settings);
        new AddAccountDialog(providers, this._extensionPath, added => this._persist([...readProviders(this._settings), ...added])).present(this._window);
    }

    private _edit(provider: ProviderInstance): void {
        this._window.push_subpage(new AccountPage(this._settings, provider, {
            update: value => this._persist(readProviders(this._settings).map(item => item.id === value.id ? value : item)),
            remove: providerId => {
                this._persist(readProviders(this._settings).filter(item => item.id !== providerId));
                this._window.pop_subpage();
            },
        }));
    }

    // The switches change the setting without a redraw, so the dialog starts from
    // the saved accounts and only their order is taken back from it.
    private _reorder(): void {
        const save = (ordered: ProviderInstance[]) =>
            this._persist(reorderProviders(readProviders(this._settings), ordered.map(provider => provider.id)));
        new ReorderDialog(readProviders(this._settings), this._extensionPath, save).present(this._window);
    }

    private _discover(): void {
        const providers = readProviders(this._settings);
        new DiscoverDialog(providers, this._extensionPath, added => this._persist([...readProviders(this._settings), ...added])).present(this._window);
    }
}
