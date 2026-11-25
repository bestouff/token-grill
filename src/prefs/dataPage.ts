import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {displayPath} from '../core/paths.js';
import type {PrefsContext} from './context.js';
import {isDismissal} from './widgets.js';

Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

// The service keeps its files where 0.4.1 kept them.
const APP_DIRECTORY = 'token-grill';

export class DataPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillDataPage'}, this);
    }

    private readonly _context: PrefsContext;

    constructor(context: PrefsContext) {
        super({title: _('Data'), icon_name: 'folder-symbolic'});
        this._context = context;

        const group = new Adw.PreferencesGroup({
            title: _('Local Data'),
            description: _('Only compact aggregates and checkpoints are stored; logs of the services are never modified'),
        });
        group.add(new Adw.ActionRow({
            title: _('Usage History'),
            subtitle: displayPath(GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIRECTORY, 'history-v1.json'])),
            subtitle_selectable: true,
        }));
        group.add(new Adw.ActionRow({
            title: _('Parser Checkpoints'),
            subtitle: displayPath(GLib.build_filenamev([GLib.get_user_state_dir(), APP_DIRECTORY, 'checkpoints-v1.json'])),
            subtitle_selectable: true,
        }));
        this.add(group);

        const diagnostics = new Adw.PreferencesGroup({
            title: _('Diagnostics'),
            description: _('Recent refresh steps for a bug report, without tokens, keys, e-mail addresses, account names or your home folder; ' +
                'responses keep only their field names and types'),
        });
        const save = new Adw.ButtonRow({title: _('Save Diagnostics Report...'), start_icon_name: 'document-save-symbolic'});
        // The service redacts the report before it sends it.
        save.connect('activated', () => context.request(client => client.diagnosticsReport(), {
            done: report => this._saveReport(report),
            failed: () => this._toast(_('The report could not be saved')),
        }));
        diagnostics.add(save);
        this.add(diagnostics);
    }

    private _saveReport(report: string): void {
        const cancellable = this._context.cancellable;
        const dialog = new Gtk.FileDialog({title: _('Save Diagnostics Report'), initial_name: 'token-grill-diagnostics.txt'});
        dialog.save(this._context.window, cancellable).then(async file => {
            if (!file)
                return;
            await file.replace_contents_async(new TextEncoder().encode(report), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
            this._toast(_('Report saved'));
        }).catch(error => {
            if (isDismissal(error))
                return;
            if (!(error instanceof GLib.Error))
                this._context.logger.error(error);
            this._toast(_('The report could not be saved'));
        });
    }

    private _toast(title: string): void {
        this._context.window.add_toast(new Adw.Toast({title}));
    }
}
