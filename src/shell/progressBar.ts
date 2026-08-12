// @ts-nocheck
import Clutter from 'gi://Clutter';
import St from 'gi://St';

export function createMeter(label: string, percent: number | null, reset: string): St.BoxLayout {
    const box = new St.BoxLayout({vertical: true, x_expand: true});
    const header = new St.BoxLayout({x_expand: true});
    header.add_child(new St.Label({text: label, x_expand: true}));
    header.add_child(new St.Label({text: percent === null ? '—' : `${Math.round(percent * 100)}%`}));
    const bar = new St.DrawingArea({style_class: 'tokengrill-progress', x_expand: true, height: 6});
    bar.connect('repaint', area => {
        const cr = area.get_context(); const width = area.get_width(); const height = area.get_height();
        const value = Math.max(0, Math.min(percent ?? 0, 1));
        cr.setSourceRGBA(0.25, 0.3, 0.35, 0.5); cr.rectangle(0, 0, width, height); cr.fill();
        cr.setSourceRGBA(value >= 0.95 ? 0.93 : value >= 0.8 ? 0.9 : 0.2, value >= 0.8 ? 0.55 : 0.75, 0.45, 0.95); cr.rectangle(0, 0, width * value, height); cr.fill();
    });
    box.add_child(header); box.add_child(bar); box.add_child(new St.Label({text: `Reset: ${reset}`, style_class: 'tokengrill-muted', y_align: Clutter.ActorAlign.CENTER}));
    return box;
}
