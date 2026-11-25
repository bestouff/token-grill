import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {isCancellation} from '../core/gio.js';
import {providerIconFile} from '../core/providerMetadata.js';
import type {AccentColor, ProviderKind, Settings} from '../core/types.js';
import type {PrefsContext} from './context.js';

export function providerIcon(extensionPath: string, kind: ProviderKind): Gtk.Image {
    const file = Gio.File.new_for_path(`${extensionPath}/icons/providers/${providerIconFile(kind)}`);
    return new Gtk.Image({gicon: Gio.FileIcon.new(file)});
}

export function setAccessibleLabel(widget: Gtk.Widget, label: string): void {
    widget.update_property([Gtk.AccessibleProperty.LABEL], [label]);
}

export function accentName(color: AccentColor): string {
    const names: Record<AccentColor, string> = {
        blue: _('Blue'),
        teal: _('Teal'),
        green: _('Green'),
        yellow: _('Yellow'),
        orange: _('Orange'),
        red: _('Red'),
        pink: _('Pink'),
        purple: _('Purple'),
        slate: _('Slate'),
    };
    return names[color];
}

// The codes of the service's account checks, which are the 0.4.1 ones.
function validationMessage(code: string): string | null {
    switch (code) {
    case 'required':
        return _('This field is required');
    case 'not-absolute':
        return _('Use an absolute path or one that starts with ~/');
    case 'duplicate-home':
        return _('Another account already uses this home');
    default:
        return null;
    }
}

export function markField(row: Adw.EntryRow, code: string | undefined): void {
    if (code) {
        row.add_css_class('error');
        row.tooltip_text = validationMessage(code);
    } else {
        row.remove_css_class('error');
        row.tooltip_text = null;
    }
}

// The fields the service refused, by draft; null when the call itself failed.
export function presentAddError(parent: Gtk.Widget, errors: Record<string, Record<string, string>> | null): void {
    const codes = Object.values(errors ?? {}).flatMap(fields => Object.values(fields));
    const count = Math.max(1, Object.keys(errors ?? {}).length);
    const messages = codes.map(validationMessage).filter(message => message !== null);
    const alert = new Adw.AlertDialog({
        heading: ngettext('Could Not Add the Account', 'Could Not Add the Accounts', count),
        body: messages[0] ?? ngettext('The account was not added. Try again later.', 'The accounts were not added. Try again later.', count),
    });
    alert.add_response('close', _('Close'));
    alert.present(parent);
}

export function presentKeyError(parent: Gtk.Widget): void {
    const alert = new Adw.AlertDialog({heading: _('Could Not Save the Key'), body: _('The system keyring did not save the key.')});
    alert.add_response('close', _('Close'));
    alert.present(parent);
}

type NumberSetting = 'refreshIntervalSeconds' | 'alertStepPercent';

// A setting that the service keeps: the row follows the service, and a change the user makes is
// sent to it. A refused change puts the row back.
export function bindServiceNumber(context: PrefsContext, key: NumberSetting, row: Adw.SpinRow): void {
    const show = () => {
        const settings = context.settings;
        if (settings !== null)
            row.value = settings[key];
    };
    context.watch('settings', show);
    show();
    row.connect('notify::value', () => {
        const value = Math.round(row.value);
        if (context.settings === null || context.settings[key] === value)
            return;
        const patch: Partial<Settings> = {};
        patch[key] = value;
        context.request(client => client.setSettings(patch), {failed: show});
    });
}

export function bindServiceSwitch(context: PrefsContext, key: 'alertsEnabled', row: Adw.SwitchRow): void {
    const show = () => {
        const settings = context.settings;
        if (settings !== null)
            row.active = settings[key];
    };
    context.watch('settings', show);
    show();
    row.connect('notify::active', () => {
        if (context.settings === null || context.settings[key] === row.active)
            return;
        const patch: Partial<Settings> = {};
        patch[key] = row.active;
        context.request(client => client.setSettings(patch), {failed: show});
    });
}

// Closing the file dialog is a choice, not a failure.
export function isDismissal(error: unknown): boolean {
    return isCancellation(error) || (error instanceof GLib.Error && error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED));
}
