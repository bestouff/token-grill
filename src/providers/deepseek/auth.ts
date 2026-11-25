import type Gio from 'gi://Gio';

import {CollectorError, type ErrorText} from '../../core/errors.js';
import {providerPaths} from '../../core/paths.js';
import type {ProviderInstance} from '../../core/types.js';
import {readCredentialJson} from '../credentials.js';
import {lookupSecret, TOKEN_GRILL_KEY_SCHEMA} from '../keyring.js';
import {readOpenCodeEntries} from '../opencode/authFile.js';
import {deepSeekKeyFromClaudeSettings} from './normalize.js';

const KEYRING_UNAVAILABLE: ErrorText = ({_}) => _('The system keyring is locked or not available, so the DeepSeek API key cannot be read.');

const NO_KEY = () => new CollectorError('auth-missing', ({_}) => _('No DeepSeek API key was found.'));

// The API key from wherever the account was added: Token Grill's own keyring
// entry, OpenCode, or Claude Code settings that point at DeepSeek.
export async function loadDeepSeekKey(instance: ProviderInstance, cancellable: Gio.Cancellable): Promise<string> {
    let key: string | null = null;
    if (instance.app === 'keyring') {
        key = await lookupSecret(TOKEN_GRILL_KEY_SCHEMA, {account: instance.id}, cancellable, KEYRING_UNAVAILABLE);
    } else if (instance.app === 'opencode') {
        const entry = (await readOpenCodeEntries(cancellable)).get('deepseek');
        key = entry?.type === 'api' ? entry.key : null;
    } else {
        key = deepSeekKeyFromClaudeSettings(await readCredentialJson(providerPaths(instance).authFile, cancellable));
    }
    if (!key)
        throw NO_KEY();
    return key;
}
