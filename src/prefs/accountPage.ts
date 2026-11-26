import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {accentHex} from '../core/accent.js';
import {credentialLabel} from '../core/accountText.js';
import {formatText} from '../core/i18n.js';
import {displayPath, expandPath} from '../core/paths.js';
import {providerMetadata} from '../core/providerMetadata.js';
import {topBarSummary} from '../core/topBar.js';
import {ACCENTS, type AccentColor, type AccountApp, type ProviderInstance} from '../core/types.js';
import type {PrefsContext} from './context.js';
import {TRANSLATOR} from './translator.js';
import {accentName, markField, presentKeyError, setAccessibleLabel} from './widgets.js';

type PathField = 'accountHome' | 'authFileOverride' | 'sessionsDirectoryOverride';

// App names are product names and stay as they are.
const APP_NAMES: Record<AccountApp, string> = {
    'codex-cli': 'Codex CLI',
    'claude-code': 'Claude Code',
    'kiro-cli': 'Kiro CLI',
    antigravity: 'Antigravity',
    opencode: 'OpenCode',
    'github-cli': 'GitHub CLI',
    'copilot-cli': 'Copilot CLI',
    keyring: 'GNOME Keyring',
    'claude-settings': 'Claude Code',
    'kimi-cli': 'Kimi CLI',
    cursor: 'Cursor',
    'cursor-agent': 'Cursor CLI',
};

// Apps whose sign-in is a file in the account home, so the home and file can be changed.
const FILE_APPS: AccountApp[] = ['codex-cli', 'claude-code', 'kiro-cli', 'antigravity', 'github-cli', 'claude-settings', 'kimi-cli', 'cursor', 'cursor-agent'];

function hexFromRgba(rgba: Gdk.RGBA): `#${string}` {
    const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0');
    return `#${channel(rgba.red)}${channel(rgba.green)}${channel(rgba.blue)}`;
}

function rgbaFromHex(hex: string): Gdk.RGBA {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex);
    return rgba;
}

// One account: what users change often first, rare options folded away.
// Changes apply at once, like GNOME Settings.
export class AccountPage extends Adw.NavigationPage {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillAccountPage'}, this);
    }

    private readonly _context: PrefsContext;
    // Replies that arrive after the page is closed are dropped.
    private readonly _cancellable = new Gio.Cancellable();
    private readonly _swatches = new Map<AccentColor, Gtk.ToggleButton>();
    private readonly _custom: Gtk.ColorDialogButton;
    private readonly _topBar: Adw.ActionRow;
    private _provider: ProviderInstance;
    private _unwatch: (() => void) | null;

    constructor(context: PrefsContext, provider: ProviderInstance) {
        super({title: provider.displayName, tag: provider.id});
        this._context = context;
        this._provider = provider;
        const metadata = providerMetadata(provider.kind);

        const page = new Adw.PreferencesPage();
        const header = new Adw.HeaderBar();
        const toolbar = new Adw.ToolbarView({content: page});
        toolbar.add_top_bar(header);
        this.set_child(toolbar);

        const main = new Adw.PreferencesGroup();
        const name = new Adw.EntryRow({title: _('Name'), text: provider.displayName, show_apply_button: true});
        name.connect('apply', () => this._rename(name));
        main.add(name);

        this._custom = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({title: _('Custom Color'), with_alpha: false}),
            rgba: rgbaFromHex(accentHex(provider.accent)),
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Custom Color'),
        });
        setAccessibleLabel(this._custom, _('Custom Color'));

        main.add(this._signedInRow());
        this._topBar = new Adw.ActionRow({title: _('Top Bar'), subtitle: this._topBarText()});
        main.add(this._topBar);

        // Kept near the top so that the switch is visible without scrolling.
        if (metadata.localHistorySupported && provider.app === metadata.apps[0]) {
            const history = new Adw.SwitchRow({
                title: _('Local History'),
                subtitle: _('Index token accounting without storing prompts or responses'),
                active: provider.localHistoryEnabled,
            });
            history.connect('notify::active', () => this._apply({localHistoryEnabled: history.active}));
            main.add(history);
        }
        if (metadata.measure === 'limits') {
            const pace = new Adw.SwitchRow({
                title: _('Usage Pace'),
                subtitle: _('Shows whether a limit is used faster or slower than its period passes, in the popup and next to the limits in the top bar'),
                active: provider.showPace,
            });
            pace.connect('notify::active', () => this._apply({showPace: pace.active}));
            main.add(pace);
        }
        page.add(main);

        const colors = new Adw.PreferencesGroup({title: _('Color')});
        colors.add(this._buildSwatches());
        page.add(colors);

        const more = new Adw.PreferencesGroup();
        more.add(this._moreOptions());
        page.add(more);
        page.add(this._removal());

        this._unwatch = context.watch('accounts', () => this._onStoredChanged());
        this.connect('hidden', () => this._release());
        this.connect('destroy', () => this._release());
    }

    private _release(): void {
        this._cancellable.cancel();
        if (this._unwatch !== null)
            this._unwatch();
        this._unwatch = null;
    }

    // The popup can change the top-bar choice while this page is open.
    private _onStoredChanged(): void {
        const stored = this._context.accounts.find(item => item.id === this._provider.id);
        if (!stored)
            return;
        this._provider = stored;
        this._topBar.subtitle = this._topBarText();
    }

    private _topBarText(): string {
        // Translators: the account's top-bar choice, then a hint.
        return formatText(_('%s - Change this in the popup'), topBarSummary(TRANSLATOR, this._provider.topBar));
    }

    // Only the changed fields go to the service, so a top-bar choice made in the popup meanwhile stays.
    // The service checks the change again; a refused field is marked on its row.
    private _apply(change: Partial<ProviderInstance>, row: Adw.EntryRow | null = null, field: PathField | 'displayName' | null = null): void {
        this._provider = {...this._provider, ...change};
        this._context.request(client => client.updateAccount({id: this._provider.id, ...change}), {
            done: errors => {
                if (row !== null && field !== null)
                    markField(row, errors[field]);
            },
            cancellable: this._cancellable,
        });
    }

    private _rename(row: Adw.EntryRow): void {
        const text = row.text.trim();
        const draft = {...this._provider, displayName: text};
        this._context.request(client => client.validateAccount(draft), {
            done: errors => {
                markField(row, errors.displayName);
                if (errors.displayName)
                    return;
                this.title = text;
                this._apply({displayName: text}, row, 'displayName');
            },
            cancellable: this._cancellable,
        });
    }

    private _buildSwatches(): Gtk.Box {
        const box = new Gtk.Box({spacing: 4, margin_top: 8, margin_bottom: 8, halign: Gtk.Align.START});
        for (const color of ACCENTS) {
            const label = accentName(color);
            const button = new Gtk.ToggleButton({
                css_classes: ['tokengrill-swatch', `tokengrill-accent-${color}`],
                tooltip_text: label,
                valign: Gtk.Align.CENTER,
                active: color === this._provider.accent,
            });
            setAccessibleLabel(button, label);
            button.connect('clicked', () => this._chooseAccent(color));
            this._swatches.set(color, button);
            box.append(button);
        }
        this._custom.connect('notify::rgba', () => {
            const hex = hexFromRgba(this._custom.rgba);
            if (hex !== accentHex(this._provider.accent))
                this._chooseAccent(hex);
        });
        box.append(this._custom);
        return box;
    }

    private _chooseAccent(accent: ProviderInstance['accent']): void {
        if (accent !== this._provider.accent)
            this._apply({accent});
        for (const [color, button] of this._swatches)
            button.active = color === accent;
        // Stored first, so the custom button's handler sees this colour as current and ignores the echo.
        this._custom.rgba = rgbaFromHex(accentHex(accent));
    }

    private _signedInRow(): Adw.ActionRow {
        const provider = this._provider;
        const where = FILE_APPS.includes(provider.app) && provider.accountHome ? displayPath(provider.accountHome) : null;
        const app = APP_NAMES[provider.app];
        // Translators: an app name, then where its sign-in is read.
        const source = where ? formatText(_('%s - %s'), app, where) : app;
        const row = new Adw.ActionRow({title: _('Signed In With'), subtitle: source});
        this._context.request(client => client.credentialState(provider.id), {
            done: state => {
                const label = credentialLabel(TRANSLATOR, state);
                if (label !== null)
                    row.subtitle = formatText(_('%s - %s'), source, label);
            },
            cancellable: this._cancellable,
        });
        return row;
    }

    private _moreOptions(): Adw.ExpanderRow {
        const provider = this._provider;
        const metadata = providerMetadata(provider.kind);
        const more = new Adw.ExpanderRow({title: _('More Options')});

        const live = new Adw.SwitchRow({
            title: _('Live Quota'),
            subtitle: _('Read the service quota endpoint using this account'),
            active: provider.liveUsageEnabled,
        });
        live.connect('notify::active', () => this._apply({liveUsageEnabled: live.active}));
        more.add_row(live);

        if (FILE_APPS.includes(provider.app)) {
            more.add_row(this._pathRow(_('Account Home'), provider.accountHome, 'accountHome'));
            more.add_row(this._pathRow(_('Sign-In File Override'), provider.authFileOverride ?? '', 'authFileOverride'));
            if (metadata.localHistorySupported && provider.app === metadata.apps[0])
                more.add_row(this._pathRow(_('Sessions Directory Override'), provider.sessionsDirectoryOverride ?? '', 'sessionsDirectoryOverride'));
        }

        if (metadata.measure === 'balance') {
            const warn = new Adw.SpinRow({
                title: _('Warn Below'),
                subtitle: _('Alert when the balance drops below this amount; 0 turns it off'),
                digits: 2,
                adjustment: new Gtk.Adjustment({lower: 0, upper: 100000, step_increment: 1, page_increment: 10, value: provider.lowBalance ?? 0}),
            });
            warn.connect('notify::value', () => this._apply({lowBalance: warn.value > 0 ? warn.value : null}));
            more.add_row(warn);
        }
        if (provider.app === 'keyring')
            more.add_row(this._replaceKeyRow());
        return more;
    }

    // Paths apply when confirmed, and only when valid. The service checks the path as typed, and
    // saves a valid one expanded.
    private _pathRow(title: string, value: string, field: PathField): Adw.EntryRow {
        const row = new Adw.EntryRow({title, text: value, show_apply_button: true});
        row.connect('apply', () => {
            const text = row.text.trim();
            const draft = {...this._provider, [field]: field === 'accountHome' ? text : text || null};
            this._context.request(client => client.validateAccount(draft), {
                done: errors => {
                    markField(row, errors[field]);
                    if (errors[field])
                        return;
                    this._apply({[field]: text ? expandPath(text) : null}, row, field);
                },
                cancellable: this._cancellable,
            });
        });
        return row;
    }

    private _replaceKeyRow(): Adw.PasswordEntryRow {
        const row = new Adw.PasswordEntryRow({title: _('Replace API Key'), show_apply_button: true});
        row.connect('apply', () => {
            const key = row.text.trim();
            if (!key)
                return;
            this._context.request(client => client.saveApiKey(this._provider.id, key), {
                done: () => {
                    row.text = '';
                },
                failed: () => presentKeyError(this),
                cancellable: this._cancellable,
            });
        });
        return row;
    }

    private _removal(): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({description: _('Credentials, sessions and files of the app are never changed')});
        const remove = new Adw.ButtonRow({title: _('Remove Account'), start_icon_name: 'user-trash-symbolic'});
        // The css_classes property would replace the classes the row sets on itself.
        remove.add_css_class('destructive-action');
        remove.connect('activated', () => this._confirmRemove());
        group.add(remove);
        return group;
    }

    private _confirmRemove(): void {
        const alert = new Adw.AlertDialog({
            heading: _('Remove Account?'),
            body: this._provider.app === 'keyring'
                ? _('This removes the account, its collected totals and its API key from the keyring.')
                : _("This removes the account and its collected totals from Token Grill. The app's sign-in is untouched."),
            close_response: 'cancel',
        });
        alert.add_response('cancel', _('Cancel'));
        alert.add_response('remove', _('Remove'));
        alert.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        alert.connect('response', (_alert, response) => {
            if (response !== 'remove')
                return;
            // The service also removes a pasted key from the keyring.
            this._context.request(client => client.removeAccount(this._provider.id, this._provider.app === 'keyring'), {
                done: () => this._context.window.pop_subpage(),
                cancellable: this._cancellable,
            });
        });
        alert.present(this);
    }
}
