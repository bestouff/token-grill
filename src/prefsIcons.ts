import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

export function registerPreferencesIcons(basePath: string): void {
    const display = Gdk.Display.get_default();
    if (display) Gtk.IconTheme.get_for_display(display).add_search_path(`${basePath}/icons/ui`);
}

export function preferencesPageIcon(preferred: string, fallback: string): string {
    const display = Gdk.Display.get_default();
    if (display && Gtk.IconTheme.get_for_display(display).has_icon(preferred)) return preferred;
    return fallback;
}
