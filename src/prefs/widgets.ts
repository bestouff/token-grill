import type Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {isCancellation} from '../core/gio.js';
import {providerIconFile} from '../core/providerMetadata.js';
import type {AccentColor, ProviderKind} from '../core/types.js';
import type {ProviderValidationCode} from './providerValidation.js';

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

function validationMessage(code: ProviderValidationCode): string {
    const messages: Record<ProviderValidationCode, string> = {
        required: _('This field is required'),
        'not-absolute': _('Use an absolute path or one that starts with ~/'),
        'duplicate-home': _('Another account already uses this home'),
    };
    return messages[code];
}

export function markField(row: Adw.EntryRow, code: ProviderValidationCode | undefined): void {
    if (code) {
        row.add_css_class('error');
        row.tooltip_text = validationMessage(code);
    } else {
        row.remove_css_class('error');
        row.tooltip_text = null;
    }
}

// Closing the file dialog is a choice, not a failure.
export function isDismissal(error: unknown): boolean {
    return isCancellation(error) || (error instanceof GLib.Error && error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED));
}
