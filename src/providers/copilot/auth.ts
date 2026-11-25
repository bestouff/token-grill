import type Gio from 'gi://Gio';

import {CollectorError, type ErrorText} from '../../core/errors.js';
import {providerPaths} from '../../core/paths.js';
import type {ProviderInstance} from '../../core/types.js';
import {readCredentialText} from '../credentials.js';
import {lookupSecret} from '../keyring.js';
import {readOpenCodeEntries} from '../opencode/authFile.js';
import {openCodeGitHubToken} from '../opencode/entries.js';
import {parseGhHosts} from './ghHosts.js';

// Both CLIs store their token as a generic secret, keyed by service (gh adds the user).
const GENERIC_SCHEMA = 'org.freedesktop.Secret.Generic';

const KEYRING_UNAVAILABLE: ErrorText = ({_}) => _('The system keyring is locked or not available, so the GitHub sign-in cannot be read.');

async function githubCliToken(instance: ProviderInstance, cancellable: Gio.Cancellable): Promise<string> {
    const hosts = parseGhHosts(await readCredentialText(providerPaths(instance).authFile, cancellable));
    if (hosts.token)
        return hosts.token;
    const token = hosts.user ? await lookupSecret(GENERIC_SCHEMA, {service: 'gh:github.com', username: hosts.user}, cancellable, KEYRING_UNAVAILABLE) : null;
    if (!token)
        throw new CollectorError('auth-missing', ({_}) => _('The GitHub CLI is not signed in.'));
    return token;
}

export async function copilotCliToken(cancellable: Gio.Cancellable): Promise<string> {
    const token = await lookupSecret(GENERIC_SCHEMA, {service: 'copilot-cli'}, cancellable, KEYRING_UNAVAILABLE);
    if (!token)
        throw new CollectorError('auth-missing', ({_}) => _('The Copilot CLI is not signed in.'));
    return token;
}

// The GitHub token of the account, read from the app it was added from; never stored.
export async function loadCopilotToken(instance: ProviderInstance, cancellable: Gio.Cancellable): Promise<string> {
    switch (instance.app) {
    case 'opencode':
        return openCodeGitHubToken((await readOpenCodeEntries(cancellable)).get('github-copilot'));
    case 'copilot-cli':
        return copilotCliToken(cancellable);
    default:
        return githubCliToken(instance, cancellable);
    }
}
