import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import type Cairo from 'cairo';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {accentStyleClass} from '../core/accent.js';
import {displayLabel, displayPercent, selectWindow} from '../core/display.js';
import {providerIconFile, providerMetadata} from '../core/providerMetadata.js';
import type {PanelDisplayStyle, PanelPercentageMode, ProviderInstance, ProviderKind, ProviderSnapshot} from '../core/types.js';
import {TRANSLATOR} from './translator.js';

const MARK_DOT_SIZE = 6;

export function providerGicon(extensionPath: string, kind: ProviderKind): Gio.Icon {
    return Gio.icon_new_for_string(`${extensionPath}/icons/providers/${providerIconFile(kind)}`);
}

export function providerIcon(extensionPath: string, kind: ProviderKind, size: number): St.Icon {
    return new St.Icon({
        gicon: providerGicon(extensionPath, kind),
        icon_size: size,
        style_class: 'tokengrill-provider-icon',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// A small dot in the account's GNOME accent colour.  It always sits next to
// the account name or icon, so colour is never the only way to tell accounts apart.
export function accentDot(instance: Pick<ProviderInstance, 'accent'>, size: number): St.Widget {
    return new St.Widget({
        width: size,
        height: size,
        style_class: `tokengrill-account-dot ${accentStyleClass(instance.accent)}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export function providerMark(extensionPath: string, instance: ProviderInstance, size: number): St.Widget {
    // Fixed positioning is intentional. BinLayout expands children by default,
    // which distorted the accent dot and pulled the icon off centre.
    const mark = new St.Widget({
        width: size,
        height: size,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        y_expand: false,
        layout_manager: new Clutter.FixedLayout(),
        style_class: 'tokengrill-provider-mark',
    });
    const iconSize = Math.max(12, size - 4);
    const icon = providerIcon(extensionPath, instance.kind, iconSize);
    const offset = Math.floor((size - iconSize) / 2);
    icon.set_position(offset, offset);
    mark.add_child(icon);
    const dot = accentDot(instance, MARK_DOT_SIZE);
    dot.set_position(size - MARK_DOT_SIZE, size - MARK_DOT_SIZE);
    mark.add_child(dot);
    return mark;
}

export function createPanelDisplay(
    extensionPath: string,
    instance: ProviderInstance,
    snapshot: ProviderSnapshot | null,
    mode: PanelPercentageMode,
    style: PanelDisplayStyle
): St.BoxLayout {
    const window = selectWindow(snapshot, instance.panelWindowPreference);
    const percent = displayPercent(window, mode);
    const label = displayLabel(TRANSLATOR, window, mode);
    const box = new St.BoxLayout({style_class: 'tokengrill-panel-display', y_align: Clutter.ActorAlign.CENTER, y_expand: false});
    box.add_child(providerMark(extensionPath, instance, 20));
    const reading = style === 'text'
        ? new St.Label({text: label, style_class: 'tokengrill-panel-value', y_align: Clutter.ActorAlign.CENTER})
        : createMeter(percent, style === 'ring');
    box.add_child(reading);
    const states = [];
    if (snapshot?.error) {
        if (percent !== null) {
            // Cached numbers stay readable but recede while the account needs attention.
            reading.opacity = 160;
            states.push(_('showing cached data'));
        }
        box.add_child(new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            icon_size: 14,
            style_class: 'tokengrill-panel-attention',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        states.push(_('needs attention'));
    }
    box.set_accessible_name([`${providerMetadata(instance.kind).label} ${instance.displayName}`, label, ...states].join(', '));
    return box;
}

function roundedRect(cr: Cairo.Context, x: number, y: number, width: number, height: number): void {
    const radius = Math.min(height / 2, width / 2);
    cr.newPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

// Ring or bar meter drawn in the shell accent colour (see `.tokengrill-panel-meter`).
function createMeter(percent: number | null, ring: boolean): St.DrawingArea {
    const area = new St.DrawingArea({
        width: ring ? 22 : 40,
        height: ring ? 22 : 20,
        style_class: 'tokengrill-panel-meter',
        y_align: Clutter.ActorAlign.CENTER,
        y_expand: false,
    });
    area.connectObject('repaint', () => {
        const cr = area.get_context();
        const color = area.get_theme_node().get_foreground_color();
        const value = Math.max(0, Math.min(percent ?? 0, 1));
        const [width, height] = area.get_surface_size();
        const setColor = (alpha: number) => cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, alpha);
        if (ring) {
            cr.setLineWidth(2.4);
            setColor(0.3);
            cr.arc(width / 2, height / 2, 8, 0, Math.PI * 2);
            cr.stroke();
            setColor(1);
            cr.arc(width / 2, height / 2, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * value);
            cr.stroke();
        } else {
            const barHeight = 6;
            const top = (height - barHeight) / 2;
            roundedRect(cr, 2, top, width - 4, barHeight);
            setColor(0.3);
            cr.fill();
            cr.save();
            cr.rectangle(2, top, (width - 4) * value, barHeight);
            cr.clip();
            roundedRect(cr, 2, top, width - 4, barHeight);
            setColor(1);
            cr.fill();
            cr.restore();
        }
        cr.$dispose();
    }, area);
    return area;
}
