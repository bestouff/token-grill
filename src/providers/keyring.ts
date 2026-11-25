import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret?version=1';

import {CollectorError, type ErrorText} from '../core/errors.js';
import {isCancellation} from '../core/gio.js';

Gio._promisify(Secret.Service.prototype, 'search', 'search_finish');

// A running Secret Service answers in milliseconds, but when none is running
// D-Bus activation waits about 25 seconds, which would stall every refresh.
const LOOKUP_TIMEOUT_MS = 3000;

// Token Grill's own items: an API key the user pasted, keyed by account id.
export const TOKEN_GRILL_KEY_SCHEMA = 'org.gnome.shell.extensions.tokengrill.ApiKey';

// The typings give Service.get no promise form.
function secretService(cancellable: Gio.Cancellable): Promise<Secret.Service> {
    return new Promise((resolve, reject) => {
        Secret.Service.get(Secret.ServiceFlags.NONE, cancellable, (_source, result) => {
            try {
                resolve(Secret.Service.get_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

// Reads another app's keyring item. Never asks the keyring to unlock: a password
// prompt during a background refresh would be hostile, so a locked keyring counts
// as unavailable. A plain lookup would unlock a locked match, so this searches
// without SearchFlags.UNLOCK and reads only items that are already unlocked.
export async function lookupSecret(
    schemaName: string,
    attributes: Record<string, string>,
    cancellable: Gio.Cancellable,
    unavailable: ErrorText
): Promise<string | null> {
    const attributeTypes = Object.fromEntries(Object.keys(attributes).map(name => [name, Secret.SchemaAttributeType.STRING]));
    const schema = Secret.Schema.new(schemaName, Secret.SchemaFlags.NONE, attributeTypes);
    const lookup = new Gio.Cancellable();
    let timedOut = false;
    let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOOKUP_TIMEOUT_MS, () => {
        timeoutId = 0;
        timedOut = true;
        lookup.cancel();
        return GLib.SOURCE_REMOVE;
    });
    const removeTimeout = () => {
        if (timeoutId) {
            GLib.Source.remove(timeoutId);
            timeoutId = 0;
        }
    };
    // Connected after the timeout exists: connect() runs the handler at once
    // when the cancellable is already cancelled.
    const parentId = cancellable.connect(() => {
        removeTimeout();
        lookup.cancel();
    });
    let items: Secret.Item[];
    try {
        const service = await secretService(lookup);
        items = await service.search(schema, attributes, Secret.SearchFlags.LOAD_SECRETS, lookup);
    } catch (error) {
        if (!(error instanceof GLib.Error) || (!timedOut && isCancellation(error)))
            throw error;
        throw new CollectorError('dependency', unavailable);
    } finally {
        removeTimeout();
        cancellable.disconnect(parentId);
    }
    const unlocked = items.find(item => !item.get_locked());
    if (!unlocked && items.length)
        throw new CollectorError('dependency', unavailable);
    return unlocked?.get_secret()?.get_text() ?? null;
}
