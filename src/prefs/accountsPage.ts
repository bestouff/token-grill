import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {credentialLabel} from '../core/accountText.js';
import {formatText} from '../core/i18n.js';
import {providerMetadata} from '../core/providerMetadata.js';
import {topBarSummary} from '../core/topBar.js';
import type {ProviderInstance, ProviderKind} from '../core/types.js';
import {AccountPage} from './accountPage.js';
import {AddAccountDialog} from './addAccountDialog.js';
import type {PrefsContext} from './context.js';
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

function accountSubtitle(provider: ProviderInstance, status: string | null): string {
    const parts = [topBarSummary(TRANSLATOR, provider.topBar)];
    if (status !== null)
        parts.push(status);
    if (provider.app === 'opencode')
        parts.unshift(_('via OpenCode'));
    return parts.reduce((left, right) => formatText(_('%s - %s'), left, right));
}

// What the rows show or check, so a change that the rows already show does not rebuild them. A changed
// path rebuilds them, so the credential status is checked again.
function shownKey(providers: ProviderInstance[]): string {
    return JSON.stringify(providers.map(provider => [
        provider.id, provider.kind, provider.app, provider.displayName, provider.enabled, provider.topBar,
        provider.accountHome, provider.authFileOverride, provider.sessionsDirectoryOverride,
    ]));
}

export class AccountsPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillAccountsPage'}, this);
    }

    private readonly _context: PrefsContext;
    private _groups: Adw.PreferencesGroup[] = [];
    // One rendering of the rows: the credential checks of a replaced row are dropped.
    private _cancellable = new Gio.Cancellable();
    private _shown = '';

    constructor(context: PrefsContext) {
        super({title: _('Accounts'), icon_name: 'system-users-symbolic'});
        this._context = context;
        // The popup changes what each account shows in the top bar while this window is open.
        context.watch('accounts', () => {
            if (shownKey(context.accounts) !== this._shown)
                this._render();
        });
        context.window.connect('close-request', () => {
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

        const providers = this._context.accounts;
        this._shown = shownKey(providers);
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
        discover.connect('clicked', () => new DiscoverDialog(this._context).present(this._context.window));
        box.append(discover);
        const add = new Gtk.Button({label: _('Add Account...'), css_classes: ['suggested-action']});
        add.connect('clicked', () => new AddAccountDialog(this._context).present(this._context.window));
        box.append(add);
        return box;
    }

    private _buildRow(provider: ProviderInstance): Adw.ActionRow {
        const row = new Adw.ActionRow({
            title: provider.displayName,
            subtitle: accountSubtitle(provider, _('Checking credentials...')),
            activatable: true,
        });
        this._context.request(client => client.credentialState(provider.id), {
            done: state => {
                row.subtitle = accountSubtitle(provider, credentialLabel(TRANSLATOR, state));
            },
            cancellable: this._cancellable,
        });
        row.add_prefix(providerIcon(this._context.extensionPath, provider.kind));

        const enabledLabel = formatText(_('Collect usage for %s'), provider.displayName);
        const enabled = new Gtk.Switch({active: provider.enabled, valign: Gtk.Align.CENTER, tooltip_text: enabledLabel});
        setAccessibleLabel(enabled, enabledLabel);
        enabled.connect('notify::active', () => this._setEnabled(provider.id, enabled.active));
        row.add_suffix(enabled);
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        row.connect('activated', () => this._edit(provider));
        return row;
    }

    // The switch already shows the change, so the account list it brings back keeps the rows.
    private _setEnabled(providerId: string, enabled: boolean): void {
        this._shown = shownKey(this._context.accounts.map(provider => provider.id === providerId ? {...provider, enabled} : provider));
        this._context.request(client => client.updateAccount({id: providerId, enabled}), {
            done: errors => {
                if (Object.keys(errors).length)
                    this._render();
            },
            failed: () => this._render(),
        });
    }

    private _edit(provider: ProviderInstance): void {
        this._context.window.push_subpage(new AccountPage(this._context, provider));
    }

    private _reorder(): void {
        const save = (ordered: ProviderInstance[]) =>
            this._context.request(client => client.reorderAccounts(ordered.map(provider => provider.id)));
        new ReorderDialog(this._context.accounts, this._context.extensionPath, save).present(this._context.window);
    }
}
