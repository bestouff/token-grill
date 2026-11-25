import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {formatText} from '../core/i18n.js';
import {providerMetadata} from '../core/providerMetadata.js';
import {isShown, topBarSummary} from '../core/topBar.js';
import type {PrefsContext} from './context.js';
import {TRANSLATOR} from './translator.js';
import {bindServiceNumber} from './widgets.js';

interface ToggleRowOptions {
    key: string;
    title: string;
    subtitle: string;
    choices: Array<[string, string]>;
}

function toggleRow(settings: Gio.Settings, {key, title, subtitle, choices}: ToggleRowOptions): Adw.ActionRow {
    const row = new Adw.ActionRow({title, subtitle});
    const group = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
    for (const [name, label] of choices)
        group.add(new Adw.Toggle({name, label}));
    settings.bind(key, group, 'active-name', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(group);
    return row;
}

export class GeneralPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillGeneralPage'}, this);
    }

    private readonly _context: PrefsContext;
    private readonly _shown: Adw.PreferencesGroup;
    private _rows: Adw.ActionRow[] = [];

    // The look stays in GSettings; the accounts and the refresh interval are the service's.
    constructor(settings: Gio.Settings, context: PrefsContext) {
        super({title: _('General'), icon_name: 'preferences-system-symbolic'});
        this._context = context;

        const appearance = new Adw.PreferencesGroup({title: _('Top Bar')});
        appearance.add(toggleRow(settings, {
            key: 'panel-display-style',
            title: _('Style'),
            subtitle: _('How each limit appears in the top bar'),
            choices: [['text', _('Percentage')], ['ring', _('Ring')], ['bar', _('Bar')]],
        }));
        appearance.add(toggleRow(settings, {
            key: 'panel-percentage-mode',
            title: _('Show'),
            subtitle: _('How much of each limit is left, or how much is used'),
            choices: [['remaining', _('Remaining')], ['used', _('Used')]],
        }));
        appearance.add(toggleRow(settings, {
            key: 'panel-position',
            title: _('Position'),
            subtitle: _('The side of the top bar that Token Grill sits on'),
            // Translators: the top bar is mirrored in right-to-left languages, so
            // these name the start and the end side of the bar.
            choices: [['left', _('Left')], ['right', _('Right')]],
        }));
        this.add(appearance);

        this._shown = new Adw.PreferencesGroup({
            title: _('Shown in the Top Bar'),
            description: _('Change these in the popup: check the limits to show for each account'),
        });
        this.add(this._shown);
        this._updateShown();
        // The popup changes what each account shows in the top bar while this window is open.
        context.watch('accounts', () => this._updateShown());

        const updates = new Adw.PreferencesGroup({title: _('Updates')});
        const interval = new Adw.SpinRow({
            title: _('Refresh Interval'),
            subtitle: _('Seconds between quota updates'),
            adjustment: new Gtk.Adjustment({lower: 60, upper: 3600, step_increment: 60, page_increment: 300}),
        });
        bindServiceNumber(context, 'refreshIntervalSeconds', interval);
        updates.add(interval);
        const more = new Adw.ExpanderRow({title: _('More Options')});
        more.add_row(toggleRow(settings, {
            key: 'popup-account-picker',
            title: _('Account Picker in the Popup'),
            subtitle: _("Show a service's accounts as buttons or as a list"),
            choices: [['buttons', _('Buttons')], ['dropdown', _('List')]],
        }));
        updates.add(more);
        this.add(updates);
    }

    // A read-only summary; choosing what the top bar shows happens only in the popup.
    private _updateShown(): void {
        for (const row of this._rows)
            this._shown.remove(row);
        const shown = this._context.accounts.filter(provider => provider.enabled && isShown(provider));
        this._rows = shown.map(provider => new Adw.ActionRow({
            // Translators: a service name, then the account name.
            title: formatText(_('%s - %s'), providerMetadata(provider.kind).label, provider.displayName),
            subtitle: topBarSummary(TRANSLATOR, provider.topBar),
        }));
        if (!this._rows.length)
            this._rows = [new Adw.ActionRow({title: _('Nothing Is Shown'), subtitle: _('Check a limit in the popup to show it')})];
        for (const row of this._rows)
            this._shown.add(row);
    }
}
