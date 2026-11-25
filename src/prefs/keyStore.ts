import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type Gtk from 'gi://Gtk';
import Secret from 'gi://Secret?version=1';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {isCancellation} from '../core/gio.js';
import {TOKEN_GRILL_KEY_SCHEMA} from '../providers/keyring.js';

Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

function apiKeySchema(): Secret.Schema {
    return Secret.Schema.new(TOKEN_GRILL_KEY_SCHEMA, Secret.SchemaFlags.NONE, {account: Secret.SchemaAttributeType.STRING});
}

// Token Grill's own keyring item for a pasted key. Saving is a user action in
// the preferences, so here the keyring may ask to be unlocked.
export async function storeApiKey(accountId: string, key: string, cancellable: Gio.Cancellable): Promise<void> {
    await Secret.password_store(apiKeySchema(), {account: accountId}, Secret.COLLECTION_DEFAULT, _('Token Grill: DeepSeek API key'), key, cancellable);
}

export function presentKeyError(error: unknown, parent: Gtk.Widget): void {
    if (isCancellation(error))
        return;
    if (!(error instanceof GLib.Error)) {
        logError(error instanceof Error ? error : new Error(String(error)), 'Token Grill');
        return;
    }
    const alert = new Adw.AlertDialog({heading: _('Could Not Save the Key'), body: _('The system keyring did not save the key.')});
    alert.add_response('close', _('Close'));
    alert.present(parent);
}

export async function clearApiKey(accountId: string, cancellable: Gio.Cancellable | null): Promise<void> {
    await Secret.password_clear(apiKeySchema(), {account: accountId}, cancellable);
}
