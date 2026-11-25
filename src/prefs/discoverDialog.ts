import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {formatText} from '../core/i18n.js';
import {CandidateList} from './candidateList.js';
import type {PrefsContext} from './context.js';
import {presentAddError} from './widgets.js';

// Ticked accounts are added and shown in the top bar. Unticked ones are not
// added, so a found sign-in never becomes an account without the user's choice.
export class DiscoverDialog extends Adw.Dialog {
    static {
        GObject.registerClass({GTypeName: 'TokenGrillDiscoverDialog'}, this);
    }

    // Replies that arrive after the dialog is closed are dropped.
    private readonly _cancellable = new Gio.Cancellable();

    constructor(context: PrefsContext) {
        super({title: _('Discover Accounts'), content_width: 520, content_height: 600});
        this.connect('closed', () => this._cancellable.cancel());

        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        const done = new Gtk.Button({label: _('Done'), css_classes: ['suggested-action'], visible: false});
        header.pack_end(done);

        const stack = new Gtk.Stack();
        stack.add_named(new Adw.Spinner(), 'searching');
        const toolbar = new Adw.ToolbarView({content: stack});
        toolbar.add_top_bar(header);
        this.set_child(toolbar);

        const cancellable = this._cancellable;
        // An empty app asks for every app at once.
        context.request(client => client.discover(''), {
            done: candidates => {
                const list = new CandidateList(candidates, context.accounts, context.extensionPath, _('Ticked accounts are added and shown in the top bar'));
                if (!list.addable) {
                    stack.add_named(new Adw.StatusPage({
                        title: _('No New Accounts Found'),
                        description: candidates.length
                            ? _('Every account signed in on this computer is already in Token Grill')
                            : _('Sign in with one of the supported apps, then try again'),
                        icon_name: 'system-search-symbolic',
                    }), 'empty');
                    stack.visible_child_name = 'empty';
                    cancel.label = _('Close');
                    return;
                }
                list.group.title = formatText(ngettext('Found %d New Account', 'Found %d New Accounts', list.addable), list.addable);
                done.visible = true;
                // The page shows the new accounts when the service announces them.
                done.connect('clicked', () => {
                    done.sensitive = false;
                    context.request(client => client.addAccounts(list.selected()), {
                        done: ({errors}) => {
                            if (!Object.keys(errors).length) {
                                this.close();
                                return;
                            }
                            done.sensitive = true;
                            presentAddError(this, errors);
                        },
                        failed: () => {
                            done.sensitive = true;
                            presentAddError(this, null);
                        },
                        cancellable,
                    });
                });
                const page = new Adw.PreferencesPage();
                page.add(list.group);
                stack.add_named(page, 'found');
                stack.visible_child_name = 'found';
            },
            cancellable,
        });
    }
}
