import type Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {ServiceClient} from './client.js';
import {migrateOnce} from './core/migration.js';
import {AccountsPage} from './prefs/accountsPage.js';
import {PrefsContext} from './prefs/context.js';
import {DataPage} from './prefs/dataPage.js';
import {GeneralPage} from './prefs/generalPage.js';
import {NotificationsPage} from './prefs/notificationsPage.js';
import {ServicePage} from './prefs/serviceBanner.js';

export default class TokenGrillPreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        const logger = this.getLogger();

        const display = window.get_display();
        const css = new Gtk.CssProvider();
        css.load_from_path(`${this.path}/prefs.css`);
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        // One client per window; the service owns the accounts and the settings it uses itself.
        const context = new PrefsContext(window, this.path, logger, handlers => new ServiceClient('prefs', handlers, logger));
        const general = new GeneralPage(settings, context);
        const pages = [general, new AccountsPage(context), new NotificationsPage(settings, context), new DataPage(context)];
        const service = new ServicePage(() => context.client.retry());
        window.add(service);
        context.watch('status', () => {
            const status = context.client.status;
            service.update(status);
            const connected = status === 'connected';
            // The pages are in the window exactly while the service page is not.
            if (connected === (service.get_parent() === null))
                return;
            if (connected) {
                // Preferences opened before the Shell imported the 0.4 accounts import them too. The
                // service takes them once, so a second import is refused.
                context.request(client => migrateOnce(settings, client));
                pages.forEach(page => window.add(page));
                window.remove(service);
                // The window does not pick another page when its visible page goes.
                window.set_visible_page(general);
                return;
            }
            // What was opened from the pages goes with them.
            window.get_visible_dialog()?.close();
            window.pop_subpage();
            window.add(service);
            pages.forEach(page => window.remove(page));
            window.set_visible_page(service);
        });

        window.connect('close-request', () => {
            context.client.destroy();
            context.destroy();
            Gtk.StyleContext.remove_provider_for_display(display, css);
            return false;
        });
        context.client.connect().catch(error => logger.error(error));
        return Promise.resolve();
    }
}
