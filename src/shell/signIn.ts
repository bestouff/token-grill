import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The user asked for it from the popup, so the login runs where they can see
// and answer it: in their terminal, which GLib picks. No shell parses the command.
export function openSignIn(argv: string[]): void {
    const commandline = argv.map(arg => GLib.shell_quote(arg)).join(' ');
    try {
        const app = Gio.AppInfo.create_from_commandline(commandline, null, Gio.AppInfoCreateFlags.NEEDS_TERMINAL);
        app.launch([], global.create_app_launch_context(0, -1));
    } catch (error) {
        if (!(error instanceof GLib.Error))
            throw error;
        Main.notifyError(_('Token Grill Could Not Open a Terminal'), error.message);
    }
}
