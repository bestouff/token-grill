import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {formatReport, redact} from '../core/diagnostics.js';
import {displayPath} from '../core/paths.js';
import {dataPath, statePath} from '../storage/atomicJson.js';
import {readDiagnostics} from '../storage/diagnosticsStore.js';
import {isDismissal} from './widgets.js';

Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

export class DataPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillDataPage'}, this);
    }

    private readonly _window: Adw.PreferencesWindow;
    private readonly _version: string;
    private readonly _cancellable = new Gio.Cancellable();

    constructor(window: Adw.PreferencesWindow, version: string) {
        super({title: _('Data'), icon_name: 'folder-symbolic'});
        this._window = window;
        this._version = version;
        window.connect('close-request', () => {
            this._cancellable.cancel();
            return false;
        });

        const group = new Adw.PreferencesGroup({
            title: _('Local Data'),
            description: _('Only compact aggregates and checkpoints are stored; logs of the services are never modified'),
        });
        group.add(new Adw.ActionRow({
            title: _('Usage History'),
            subtitle: displayPath(dataPath('history-v1.json')),
            subtitle_selectable: true,
        }));
        group.add(new Adw.ActionRow({
            title: _('Parser Checkpoints'),
            subtitle: displayPath(statePath('checkpoints-v1.json')),
            subtitle_selectable: true,
        }));
        this.add(group);

        const diagnostics = new Adw.PreferencesGroup({
            title: _('Diagnostics'),
            description: _('Recent refresh steps for a bug report, without tokens, keys, e-mail addresses, account names or your home folder; ' +
                'responses keep only their field names and types'),
        });
        const save = new Adw.ButtonRow({title: _('Save Diagnostics Report…'), start_icon_name: 'document-save-symbolic'});
        save.connect('activated', () => {
            this._saveReport().catch(error => {
                if (isDismissal(error))
                    return;
                if (!(error instanceof GLib.Error))
                    logError(error, 'Token Grill');
                this._toast(_('The report could not be saved'));
            });
        });
        diagnostics.add(save);
        this.add(diagnostics);
    }

    private async _saveReport(): Promise<void> {
        const {about, entries} = await readDiagnostics(this._cancellable, console);
        const header = {
            version: about?.version ?? this._version,
            shell: about?.shell ?? _('unknown'),
            date: new Date().toISOString(),
        };
        // Entries were redacted when recorded; this pass covers anything added since.
        const report = redact(formatReport(entries, header), GLib.get_home_dir());
        const dialog = new Gtk.FileDialog({title: _('Save Diagnostics Report'), initial_name: 'token-grill-diagnostics.txt'});
        const file = await dialog.save(this._window, this._cancellable);
        if (!file)
            return;
        await file.replace_contents_async(new TextEncoder().encode(report), null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
        this._toast(_('Report saved'));
    }

    private _toast(title: string): void {
        this._window.add_toast(new Adw.Toast({title}));
    }
}
