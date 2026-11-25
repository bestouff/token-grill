// What the popup shows instead of the accounts while the service is missing, too old or silent.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {formatText} from '../core/i18n.js';
import type {ClientStatus} from '../core/serviceState.js';
import {serviceStatusContent, type ServiceCardPart, type ServiceFailure} from '../core/serviceMessages.js';
import {StaticMenuItem} from './providerCard.js';
import {TRANSLATOR} from './translator.js';

function textLabel(text: string, styleClass: string): St.Label {
    const label = new St.Label({text, style_class: styleClass, x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

export class ServiceCard extends StaticMenuItem {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillServiceCard'}, this);
    }

    private _box: St.BoxLayout;
    private _onCheckAgain: () => void;
    private _failure: ServiceFailure | null = null;
    private _checkAgain: St.Button | null = null;

    constructor(onCheckAgain: () => void) {
        super('tokengrill-service-card');
        this._onCheckAgain = onCheckAgain;
        this._box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'tokengrill-service-box'});
        this.add_child(this._box);
        this.visible = false;
    }

    // The failure the card shows. While the client tries again, the card keeps the last one.
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
        // A check in progress shows as an insensitive button, so a click has a visible effect.
        if (this._checkAgain)
            this._checkAgain.reactive = status !== 'connecting';
    }

    private _rebuild(failure: ServiceFailure): void {
        this._box.destroy_all_children();
        this._checkAgain = null;
        for (const part of serviceStatusContent(TRANSLATOR, failure))
            this._box.add_child(this._part(part));
    }

    private _part(part: ServiceCardPart): Clutter.Actor {
        switch (part.kind) {
        case 'title': {
            const title = textLabel(part.text, 'tokengrill-title');
            this.label_actor = title;
            return title;
        }
        case 'body':
            return textLabel(part.text, 'tokengrill-service-text');
        case 'hint':
            return textLabel(part.text, 'tokengrill-caption');
        case 'command':
            return this._command(part.text);
        }
        const button = new St.Button({
            label: part.text,
            style_class: 'button',
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        button.connectObject('clicked', () => this._onCheckAgain(), button);
        this._checkAgain = button;
        return button;
    }

    private _command(command: string): St.BoxLayout {
        const row = new St.BoxLayout({style_class: 'tokengrill-command-row', x_expand: true});
        row.add_child(textLabel(command, 'tokengrill-command'));
        const copy = new St.Button({
            style_class: 'icon-button flat',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'edit-copy-symbolic'}),
            accessible_name: formatText(_('Copy %s'), command),
        });
        copy.connectObject('clicked', () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command), copy);
        row.add_child(copy);
        return row;
    }
}
