// Run after npm test: gjs -m tools/provider-icons-test.js
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gsk from 'gi://Gsk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PROVIDER_METADATA, providerIconFile} from '../build/tests/provider-metadata.mjs';

Gtk.init();
const display = Gdk.Display.get_default();
const theme = Gtk.IconTheme.get_for_display(display);
const renderer = new Gsk.CairoRenderer();
renderer.realize_for_display(display);

try {
    for (const kind of Object.keys(PROVIDER_METADATA)) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_current_dir(), 'resources', 'icons', 'providers', providerIconFile(kind)]));
        const icon = theme.lookup_by_gicon(new Gio.FileIcon({file}), 24, 1, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_SYMBOLIC);
        for (const [name, component] of [['white', 1], ['black', 0]]) {
            const foreground = new Gdk.RGBA({red: component, green: component, blue: component, alpha: 1});
            const snapshot = new Gtk.Snapshot();
            icon.snapshot_symbolic(snapshot, 24, 24, [foreground, foreground, foreground, foreground]);
            const texture = renderer.render_texture(snapshot.to_node(), null);
            const downloader = Gdk.TextureDownloader.new(texture);
            downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);
            const [bytes, stride] = downloader.download_bytes();
            const pixels = bytes.toArray();
            let visible = 0;
            for (let y = 0; y < texture.get_height(); y++) for (let x = 0; x < texture.get_width(); x++) {
                const offset = y * stride + x * 4;
                if (pixels[offset + 3] < 16) continue;
                visible++;
                for (let channel = 0; channel < 3; channel++) {
                    if (Math.abs(pixels[offset + channel] - component * 255) > 2)
                        throw new Error(`${kind} retained a fixed SVG color instead of rendering ${name}.`);
                }
            }
            if (!visible) throw new Error(`${kind} rendered an empty icon.`);
        }
        print(`${kind}: symbolic SVG renders white and black correctly`);
    }
} finally {
    renderer.unrealize();
}
