// @ts-nocheck
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {chooseWindow, displayLabel, displayPercent, pressureClass} from '../core/display.js';
import {formatResetCountdown} from '../core/timeMath.js';
import {providerIconFile} from '../core/providerMetadata.js';

const ACCENT_COLORS = {
    blue: '#62a0ea', cyan: '#5bc0eb', green: '#57e389', amber: '#f8e45c',
    orange: '#ff9b42', red: '#ff6b6b', purple: '#c7a0ff', pink: '#f28cb1',
};

export function iconFor(instance, basePath, size = 18) {
    const file = providerIconFile(instance.kind);
    return new St.Icon({
        gicon: Gio.icon_new_for_string(`${basePath}/icons/providers/${file}`),
        icon_size: size,
        style_class: 'tokengrill-provider-icon',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export function providerMark(instance, basePath, size = 20) {
    // Fixed positioning is intentional. BinLayout expands children by default,
    // which distorted the accent dot and pulled the logo off centre.
    const mark = new St.Widget({
        width: size,
        height: size,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        y_expand: false,
        layout_manager: new Clutter.FixedLayout(),
        style_class: 'tokengrill-provider-mark',
    });
    mark.set_size(size, size);
    const iconSize = Math.max(12, size - 4);
    const icon = iconFor(instance, basePath, iconSize);
    icon.set_position(Math.floor((size - iconSize) / 2), Math.floor((size - iconSize) / 2));
    mark.add_child(icon);
    const dotSize = size >= 20 ? 6 : 5;
    const dot = new St.Widget({width: dotSize, height: dotSize, style_class: `tokengrill-account-dot tokengrill-accent-${instance.accent}`});
    dot.set_size(dotSize, dotSize);
    dot.set_position(size - dotSize, size - dotSize);
    mark.add_child(dot);
    return mark;
}

export function accentColor(instance) {
    return ACCENT_COLORS[instance.accent] || ACCENT_COLORS.blue;
}

export function createPanelDisplay(instance, snapshot, basePath, mode, style) {
    const window = chooseWindow(snapshot, instance.panelWindowPreference || 'automatic');
    const percent = displayPercent(window, mode);
    const pressure = pressureClass(window);
    const box = new St.BoxLayout({style_class: `tokengrill-panel-display tokengrill-panel-${style} tokengrill-pressure-${pressure}`, y_align: Clutter.ActorAlign.CENTER, y_expand: false});
    box.set_accessible_name(`${instance.kind} ${instance.displayName}, ${displayLabel(window, mode)}`);
    const icon = providerMark(instance, basePath, 20);
    box.add_child(icon);
    if (style === 'ring') box.add_child(createRing(percent, pressure));
    else if (style === 'bar') box.add_child(createBar(percent, pressure));
    else box.add_child(new St.Label({text: displayLabel(window, mode), style_class: 'tokengrill-panel-value', y_align: Clutter.ActorAlign.CENTER}));
    if (snapshot?.error) {
        const hasCachedQuota = Boolean(window?.percent !== null && window?.percent !== undefined);
        const glyph = hasCachedQuota ? '·' : '!';
        const status = new St.Label({text: glyph, style_class: hasCachedQuota ? 'tokengrill-panel-stale' : 'tokengrill-panel-error', y_align: Clutter.ActorAlign.CENTER});
        status.set_accessible_name(hasCachedQuota ? 'stale' : 'provider attention required');
        box.add_child(status);
    }
    return box;
}

function createRing(percent, pressure) {
    const area = new St.DrawingArea({width: 22, height: 22, style_class: `tokengrill-ring tokengrill-ring-${pressure}`});
    area.connect('repaint', widget => {
        const cr = widget.get_context();
        const width = widget.get_width();
        const height = widget.get_height();
        const value = Math.max(0, Math.min(percent ?? 0, 1));
        cr.setLineWidth(2.2);
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.35);
        cr.arc(width / 2, height / 2, 8, 0, Math.PI * 2);
        cr.stroke();
        cr.setSourceRGBA(pressure === 'critical' ? 0.95 : pressure === 'warning' ? 0.95 : 0.96, pressure === 'critical' ? 0.28 : pressure === 'warning' ? 0.62 : 0.72, 0.2, 1);
        cr.arc(width / 2, height / 2, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * value);
        cr.stroke();
    });
    return area;
}

function createBar(percent, pressure) {
    const box = new St.BoxLayout({vertical: true, style_class: 'tokengrill-panel-bar-wrap', y_align: Clutter.ActorAlign.CENTER, y_expand: false});
    const area = new St.DrawingArea({width: 40, height: 20, style_class: `tokengrill-topbar-meter tokengrill-topbar-meter-${pressure}`, y_align: Clutter.ActorAlign.CENTER, y_expand: false});
    area.connect('repaint', widget => {
        const cr = widget.get_context();
        const width = widget.get_width();
        const height = 6;
        const value = Math.max(0, Math.min(percent ?? 0, 1));
        const rounded = (x, y, w, h) => { const r = Math.min(h / 2, w / 2); cr.newPath(); cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0); cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2); cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI); cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5); cr.closePath(); };
        rounded(2, 7, width - 4, height); cr.setSourceRGBA(0.5, 0.5, 0.5, 0.35); cr.fill();
        cr.setSourceRGBA(pressure === 'critical' ? 0.95 : pressure === 'warning' ? 0.95 : 0.96, pressure === 'critical' ? 0.28 : pressure === 'warning' ? 0.62 : 0.72, 0.2, 1);
        cr.save(); cr.rectangle(2, 7, (width - 4) * value, height); cr.clip(); rounded(2, 7, width - 4, height); cr.fill(); cr.restore();
    });
    box.add_child(area);
    return box;
}

export function formatPercent(snapshot, instance, mode = 'remaining') {
    const window = chooseWindow(snapshot, instance?.panelWindowPreference || 'automatic');
    return displayLabel(window, mode);
}

export function formatReset(timestamp) {
    if (!timestamp) return 'Reset time unavailable';
    const date = GLib.DateTime.new_from_unix_local(Math.round(timestamp / 1000));
    return date ? date.format('%b %-d, %H:%M %Z') : 'Reset time unavailable';
}

export function formatRelativeReset(timestamp) {
    if (!timestamp) return 'reset unknown';
    return `resets in ${formatResetCountdown(timestamp)}`;
}
