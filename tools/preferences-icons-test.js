// Run after npm test: gjs -m tools/preferences-icons-test.js
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import {preferencesPageIcon, registerPreferencesIcons} from '../build/tests/prefs-icons.js';

Gtk.init();
registerPreferencesIcons(GLib.build_filenamev([GLib.get_current_dir(), 'resources']));
const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
for (const [preferred, fallback] of [
    ['preferences-system-symbolic', 'tokengrill-general-symbolic'],
    ['system-users-symbolic', 'tokengrill-providers-symbolic'],
    ['preferences-system-notifications-symbolic', 'tokengrill-notifications-symbolic'],
]) {
    const chosen = preferencesPageIcon(preferred, fallback);
    if (!theme.has_icon(chosen) || !theme.has_icon(fallback)) throw new Error(`Missing page icon: ${chosen}`);
    const icon = theme.lookup_icon(chosen, null, 24, 1, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_SYMBOLIC);
    if (!icon.get_file() || !icon.get_file().get_basename().includes('symbolic')) throw new Error(`Page icon did not resolve as symbolic: ${chosen}`);
    print(`${preferred} -> ${chosen}`);
}
if (preferencesPageIcon('nonexistent-icon-symbolic', 'tokengrill-general-symbolic') !== 'tokengrill-general-symbolic')
    throw new Error('Missing theme icons did not select the packaged fallback.');
if (preferencesPageIcon('folder-symbolic', 'tokengrill-general-symbolic') !== 'folder-symbolic')
    throw new Error('Existing theme icons were replaced.');
print(`Preferences icon checks passed with the ${theme.get_theme_name()} theme.`);
