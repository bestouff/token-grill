// One top-bar entry per service: its icon, then each shown account's limits as
// nested rings, thin bars or numbers, marked with the account's accent colour.
import type Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {accentRgb} from '../core/accent.js';
import {displayLabel, displayPercent, formatMoney, limitName, pressureClass} from '../core/display.js';
import {formatText} from '../core/i18n.js';
import {providerMetadata} from '../core/providerMetadata.js';
import type {TopBarAccount, TopBarGroup} from '../core/topBar.js';
import type {PaceLevel, PanelDisplayStyle, PanelPercentageMode, UsageWindow} from '../core/types.js';
import {accentDot, paceIcon, providerIcon} from './accountChip.js';
import {TRANSLATOR} from './translator.js';

// Ring radius and stroke width per number of nested limits, on a 19 px canvas.
const RINGS: Record<number, [number, number][]> = {
    1: [[7, 2.3]],
    2: [[7.6, 2], [4.3, 2]],
    3: [[8, 1.7], [5.4, 1.7], [2.9, 1.7]],
};
const MAX_RINGS = 3;
const RING_SIZE = 19;
const BAR_WIDTH = 5;
const BAR_HEIGHT = 15;
const GAP = 2;
const DOT_SIZE = 5;
const TRACK_ALPHA = 0.25;

// The pace icon is only visible, so its meaning is spoken too.
const PACE_NAMES: Record<PaceLevel, () => string> = {
    high: () => _('using it fast'),
    'on-track': () => _('on pace'),
    low: () => _('using it slowly'),
};

type Rgb = [number, number, number];

// The normal meter colour is the text colour of the panel.
function meterRgb(area: St.DrawingArea): Rgb {
    const color = area.get_theme_node().get_foreground_color();
    return [color.red / 255, color.green / 255, color.blue / 255];
}

// Danger colours come from the stylesheet so they follow the panel's light or dark set.
// The track takes the same colour: the remaining share of a nearly exhausted limit is too small to carry it alone.
function fillRgb(area: St.DrawingArea, window: UsageWindow): Rgb {
    const pressure = pressureClass(window);
    if (pressure === 'neutral')
        return meterRgb(area);
    const [found, color] = area.get_theme_node().lookup_color(`-tokengrill-${pressure}-color`, false);
    return found ? [color.red / 255, color.green / 255, color.blue / 255] : meterRgb(area);
}

function fillDot(cr: Cairo.Context, rgb: Rgb, x: number, y: number, radius: number): void {
    cr.setSourceRGBA(...rgb, 1);
    cr.arc(x, y, radius, 0, Math.PI * 2);
    cr.fill();
}

function drawingArea(width: number, height: number, draw: (area: St.DrawingArea, cr: Cairo.Context) => void): St.DrawingArea {
    const area = new St.DrawingArea({width, height, style_class: 'tokengrill-panel-meter', y_align: Clutter.ActorAlign.CENTER});
    area.connectObject('repaint', () => {
        const cr = area.get_context();
        try {
            draw(area, cr);
        } finally {
            cr.$dispose();
        }
    }, area);
    return area;
}

// Outer to inner follows the popup's order. The dot sits in the middle while it
// fits, else beside the rings: below them, it made the reading taller than the
// panel's other items.
function ringStack(account: TopBarAccount, mode: PanelPercentageMode): St.DrawingArea {
    const geometry = RINGS[account.limits.length] ?? RINGS[1]!;
    const dotBeside = account.limits.length > 2;
    const offset = dotBeside ? DOT_SIZE + GAP : 0;
    return drawingArea(offset + RING_SIZE, RING_SIZE, (area, cr) => {
        const centre = RING_SIZE / 2;
        account.limits.forEach((window, index) => {
            const [radius, width] = geometry[index] ?? geometry[0]!;
            const value = displayPercent(window, mode) ?? 0;
            const rgb = fillRgb(area, window);
            cr.setLineWidth(width);
            cr.setSourceRGBA(...rgb, TRACK_ALPHA);
            cr.arc(offset + centre, centre, radius, 0, Math.PI * 2);
            cr.stroke();
            cr.setSourceRGBA(...rgb, 1);
            cr.arc(offset + centre, centre, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * value);
            cr.stroke();
        });
        const accent = accentRgb(account.accent);
        if (dotBeside)
            fillDot(cr, accent, DOT_SIZE / 2, centre, DOT_SIZE / 2);
        else
            fillDot(cr, accent, centre, centre, account.limits.length === 1 ? 2.6 : 1.7);
    });
}

function roundedBar(cr: Cairo.Context, x: number, y: number, width: number, height: number): void {
    const radius = width / 2;
    cr.newPath();
    cr.arc(x + radius, y + radius, radius, Math.PI, 0);
    cr.arc(x + radius, y + height - radius, radius, 0, Math.PI);
    cr.closePath();
}

// The dot sits beside the bars, as beside three rings.
function barStack(account: TopBarAccount, mode: PanelPercentageMode): St.DrawingArea {
    const count = Math.max(1, account.limits.length);
    const offset = DOT_SIZE + GAP;
    const width = offset + count * BAR_WIDTH + (count - 1) * GAP;
    return drawingArea(width, BAR_HEIGHT, (area, cr) => {
        account.limits.forEach((window, index) => {
            const x = offset + index * (BAR_WIDTH + GAP);
            const value = displayPercent(window, mode) ?? 0;
            const rgb = fillRgb(area, window);
            roundedBar(cr, x, 0, BAR_WIDTH, BAR_HEIGHT);
            cr.setSourceRGBA(...rgb, TRACK_ALPHA);
            cr.fill();
            cr.save();
            cr.rectangle(x, BAR_HEIGHT * (1 - value), BAR_WIDTH, BAR_HEIGHT * value);
            cr.clip();
            roundedBar(cr, x, 0, BAR_WIDTH, BAR_HEIGHT);
            cr.setSourceRGBA(...rgb, 1);
            cr.fill();
            cr.restore();
        });
        fillDot(cr, accentRgb(account.accent), DOT_SIZE / 2, BAR_HEIGHT / 2, DOT_SIZE / 2);
    });
}

function dot(account: TopBarAccount): St.DrawingArea {
    return accentDot(account, DOT_SIZE);
}

function attention(): St.Icon {
    return new St.Icon({icon_name: 'dialog-warning-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER});
}

function numbers(account: TopBarAccount, mode: PanelPercentageMode): St.Label {
    const values = account.limits.map(window => Math.round((displayPercent(window, mode) ?? 0) * 100));
    // Translators: compact top-bar reading; %s is one or more numbers joined by "/".
    const text = formatText(_('%s%%'), values.join('/'));
    const pressures = account.limits.map(pressureClass);
    const label = new St.Label({text, style_class: 'tokengrill-panel-value', y_align: Clutter.ActorAlign.CENTER});
    if (pressures.includes('critical'))
        label.add_style_class_name('tokengrill-critical');
    else if (pressures.includes('warning'))
        label.add_style_class_name('tokengrill-warning');
    return label;
}

function accountReading(extensionPath: string, account: TopBarAccount, style: PanelDisplayStyle, mode: PanelPercentageMode): St.Widget {
    const box = new St.BoxLayout({style_class: 'tokengrill-panel-account', y_align: Clutter.ActorAlign.CENTER});
    if (account.limits.length) {
        box.add_child(style === 'text' ? dot(account) : drawnReading(account, style, mode));
        if (style === 'text')
            box.add_child(numbers(account, mode));
        if (account.pace)
            box.add_child(paceIcon(extensionPath, account.pace, 14));
        if (account.low)
            box.add_child(attention());
    } else if (account.balance) {
        box.add_child(dot(account));
        box.add_child(new St.Label({text: formatMoney(account.balance, 0), style_class: 'tokengrill-panel-value', y_align: Clutter.ActorAlign.CENTER}));
        if (account.low)
            box.add_child(attention());
    } else if (account.missing) {
        box.add_child(dot(account));
        box.add_child(attention());
    }
    return box;
}

// More than three nested rings would be too thin to read, so such an account uses bars.
function drawnReading(account: TopBarAccount, style: PanelDisplayStyle, mode: PanelPercentageMode): St.DrawingArea {
    return style === 'ring' && account.limits.length <= MAX_RINGS ? ringStack(account, mode) : barStack(account, mode);
}

function accountDescription(account: TopBarAccount, mode: PanelPercentageMode): string {
    // The warning icon is only visible, so the low state is also spoken.
    const low = account.low ? [_('balance low')] : [];
    if (account.balance && !account.limits.length)
        // Translators: screen reader text; the account name, then the balance left.
        return [formatText(_('%s, %s left'), account.name, formatMoney(account.balance, 2)), ...low].join(', ');
    if (account.missing)
        // Translators: screen reader text; %s is the account name.
        return formatText(_('%s, no reading yet'), account.name);
    const limits = account.limits.map(window => {
        // Translators: a limit name and its reading, such as "Weekly 40% left".
        const reading = formatText(_('%s %s'), limitName(TRANSLATOR, window), displayLabel(TRANSLATOR, window, mode));
        const pressure = pressureClass(window);
        if (pressure === 'critical')
            return formatText(_('%s, almost exhausted'), reading);
        return pressure === 'warning' ? formatText(_('%s, running low'), reading) : reading;
    });
    const pace = account.pace ? [PACE_NAMES[account.pace]()] : [];
    return [account.name, ...limits, ...pace, ...low].join(', ');
}

export function entryDescription(group: TopBarGroup, mode: PanelPercentageMode): string {
    return [providerMetadata(group.kind).label, ...group.accounts.map(account => accountDescription(account, mode))].join('; ');
}

export function createTopBarEntry(extensionPath: string, group: TopBarGroup, style: PanelDisplayStyle, mode: PanelPercentageMode): St.BoxLayout {
    const entry = new St.BoxLayout({
        style_class: 'tokengrill-panel-entry',
        reactive: true,
        track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    entry.add_child(providerIcon(extensionPath, group.kind, 16));
    for (const account of group.accounts)
        entry.add_child(accountReading(extensionPath, account, style, mode));
    entry.set_accessible_name(entryDescription(group, mode));
    return entry;
}
