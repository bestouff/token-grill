import Adw from 'gi://Adw';
import type Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {formatText} from '../core/i18n.js';
import type {ProviderInstance} from '../core/types.js';
import type {PrefsContext} from './context.js';
import {bindServiceNumber, bindServiceSwitch} from './widgets.js';

function accountLabel(provider: ProviderInstance): string {
    return provider.enabled ? provider.displayName : formatText(_('%s (disabled)'), provider.displayName);
}

export class NotificationsPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillNotificationsPage'}, this);
    }

    private readonly _settings: Gio.Settings;
    private readonly _context: PrefsContext;
    private _providers: ProviderInstance[] = [];
    private readonly _account: Adw.ComboRow;
    private readonly _send: Gtk.Button;

    constructor(settings: Gio.Settings, context: PrefsContext) {
        super({title: _('Notifications'), icon_name: 'preferences-system-notifications-symbolic'});
        this._settings = settings;
        this._context = context;

        const alerts = new Adw.PreferencesGroup({
            title: _('Quota Alerts'),
            description: _('Only limits shown in the top bar send alerts, once for each usage step'),
        });
        const enabled = new Adw.SwitchRow({
            title: _('Usage Notifications'),
            subtitle: _('A DeepSeek balance also warns once when it drops below its warning amount'),
        });
        bindServiceSwitch(context, 'alertsEnabled', enabled);
        const step = new Adw.SpinRow({
            title: _('Notification Step'),
            subtitle: _('Percentage of the limit between notifications'),
            adjustment: new Gtk.Adjustment({lower: 5, upper: 50, step_increment: 5, page_increment: 10}),
        });
        bindServiceNumber(context, 'alertStepPercent', step);
        alerts.add(enabled);
        alerts.add(step);
        this.add(alerts);

        const test = new Adw.PreferencesGroup({
            title: _('Test Notification'),
            description: _('Preview the current notification of an account without changing alert tracking'),
        });
        this._account = new Adw.ComboRow({title: _('Account')});
        const sendRow = new Adw.ActionRow({
            title: _('Send Test Notification'),
            subtitle: _('Works even when usage notifications are off'),
        });
        this._send = new Gtk.Button({label: _('Send Test'), css_classes: ['suggested-action'], valign: Gtk.Align.CENTER});
        this._send.connect('clicked', () => this._sendTest());
        sendRow.add_suffix(this._send);
        test.add(this._account);
        test.add(sendRow);
        this.add(test);

        this._updateAccounts();
        context.watch('accounts', () => this._updateAccounts());
        // The popup keeps the account it shows in GSettings.
        const activeId = settings.connect('changed::active-provider-id', () => this._updateAccounts());
        context.window.connect('close-request', () => {
            settings.disconnect(activeId);
            return false;
        });
    }

    private _updateAccounts(): void {
        this._providers = this._context.accounts;
        const activeId = this._settings.get_string('active-provider-id');
        const activeIndex = this._providers.findIndex(provider => provider.id === activeId);
        this._account.model = Gtk.StringList.new(this._providers.map(accountLabel));
        this._account.selected = Math.max(0, activeIndex);
        const hasAccounts = this._providers.length > 0;
        this._account.sensitive = hasAccounts;
        this._send.sensitive = hasAccounts;
    }

    // The service sends the alert to the Shell, which shows it even when usage notifications are off.
    private _sendTest(): void {
        const provider = this._providers[this._account.selected];
        if (!provider)
            return;
        this._context.request(client => client.sendTestAlert(provider.id));
    }
}
