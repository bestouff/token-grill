// What Preferences show instead of their pages while the service is missing, too old or silent.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {formatText} from '../core/i18n.js';
import type {ClientStatus} from '../core/serviceState.js';
import {serviceStatusContent, type ServiceCardPart, type ServiceFailure} from '../core/serviceMessages.js';
import {TRANSLATOR} from './translator.js';
import {setAccessibleLabel} from './widgets.js';

const ICONS: Record<ServiceFailure, string> = {
    missing: 'system-software-install-symbolic',
    'too-old': 'software-update-available-symbolic',
    'not-responding': 'dialog-warning-symbolic',
};

function textLabel(text: string, cssClasses: string[]): Gtk.Label {
    return new Gtk.Label({label: text, wrap: true, justify: Gtk.Justification.CENTER, css_classes: cssClasses});
}

// Adw.StatusPage is a final type, so the banner holds one instead of extending it.
class ServiceBanner extends Adw.Bin {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillServiceBanner'}, this);
    }

    private readonly _onCheckAgain: () => void;
    private _failure: ServiceFailure | null = null;
    private _checkAgain: Gtk.Button | null = null;
    private readonly _page = new Adw.StatusPage();

    constructor(onCheckAgain: () => void) {
        super({visible: false});
        this._onCheckAgain = onCheckAgain;
        this.set_child(this._page);
    }

    // The failure the banner shows. While the client tries again, the banner keeps the last one.
    get failure(): ServiceFailure | null {
        return this._failure;
    }

    update(status: ClientStatus): void {
        if (status === 'connected') {
            this._failure = null;
        } else if (status !== 'connecting' && status !== this._failure) {
            this._failure = status;
            this._rebuild(status);
        }
        this.visible = this._failure !== null;
        if (this._checkAgain)
            this._checkAgain.sensitive = status !== 'connecting';
    }

    // Replacing the child releases the previous parts with their buttons.
    private _rebuild(failure: ServiceFailure): void {
        this._checkAgain = null;
        this._page.icon_name = ICONS[failure];
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        for (const part of serviceStatusContent(TRANSLATOR, failure)) {
            if (part.kind === 'title')
                this._page.title = part.text;
            else
                box.append(this._part(part));
        }
        this._page.set_child(box);
    }

    // The title goes to the status page itself, in _rebuild().
    private _part(part: ServiceCardPart): Gtk.Widget {
        switch (part.kind) {
        case 'hint':
            return textLabel(part.text, ['dim-label', 'caption']);
        case 'command':
            return this._command(part.text);
        case 'check-again':
            return this._checkAgainButton(part.text);
        default:
            return textLabel(part.text, ['body']);
        }
    }

    private _checkAgainButton(label: string): Gtk.Button {
        const button = new Gtk.Button({label, halign: Gtk.Align.CENTER, css_classes: ['pill', 'suggested-action']});
        button.connect('clicked', () => this._onCheckAgain());
        this._checkAgain = button;
        return button;
    }

    private _command(command: string): Gtk.Box {
        const row = new Gtk.Box({spacing: 6, css_classes: ['card'], halign: Gtk.Align.CENTER});
        row.append(new Gtk.Label({
            label: command,
            selectable: true,
            wrap: true,
            xalign: 0,
            hexpand: true,
            margin_start: 12,
            margin_top: 6,
            margin_bottom: 6,
            css_classes: ['monospace'],
        }));
        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy'),
            valign: Gtk.Align.CENTER,
            margin_end: 6,
            css_classes: ['flat'],
        });
        setAccessibleLabel(copy, formatText(_('Copy %s'), command));
        copy.connect('clicked', () => Gdk.Display.get_default()!.get_clipboard().set(command));
        row.append(copy);
        return row;
    }
}

// The only page of the window while the service is not connected: a spinner during the first
// check, then the banner.
export class ServicePage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillServicePage'}, this);
    }

    private readonly _banner: ServiceBanner;
    private readonly _spinner = new Adw.Spinner({width_request: 32, height_request: 32, margin_top: 48});

    constructor(onCheckAgain: () => void) {
        // Alone in the window, the page has no view switcher, so it needs no title.
        super();
        this._banner = new ServiceBanner(onCheckAgain);
        const group = new Adw.PreferencesGroup();
        group.add(this._spinner);
        group.add(this._banner);
        this.add(group);
    }

    update(status: ClientStatus): void {
        this._banner.update(status);
        this._spinner.visible = this._banner.failure === null;
    }
}
