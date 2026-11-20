import type Gio from 'gi://Gio';

import {CollectorError} from '../../core/errors.js';
import {recordAt, stringAt} from '../../core/json.js';
import {providerPaths} from '../../core/paths.js';
import type {ProviderInstance} from '../../core/types.js';
import {readCredentialJson} from '../credentials.js';
import {jwtExpiry} from '../jwt.js';
import {readOpenCodeEntries} from '../opencode/authFile.js';
import {openCodeAccessToken} from '../opencode/entries.js';

export async function loadCodexAccessToken(instance: ProviderInstance, cancellable: Gio.Cancellable | null): Promise<string> {
    if (instance.app === 'opencode')
        return openCodeAccessToken((await readOpenCodeEntries(cancellable)).get('openai'), Date.now());
    const payload = await readCredentialJson(providerPaths(instance).authFile, cancellable);
    const tokens = recordAt(payload, 'tokens');
    const accessToken = tokens ? stringAt(tokens, 'access_token') : null;
    if (!accessToken)
        throw new CollectorError('auth-missing', ({_}) => _('Codex is not signed in.'));
    const expiresAt = jwtExpiry(accessToken);
    if (expiresAt !== null && expiresAt <= Date.now())
        throw new CollectorError('auth-expired', ({_}) => _('The Codex sign-in has expired.'));
    return accessToken;
}
