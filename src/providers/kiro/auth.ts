import type Gio from 'gi://Gio';

import {CollectorError} from '../../core/errors.js';
import {formatText} from '../../core/i18n.js';
import {displayPath, providerPaths} from '../../core/paths.js';
import type {ProviderInstance} from '../../core/types.js';
import {credentialErrorStatus, type CredentialStatus} from '../credentials.js';
import {databaseStamp, readDatabase} from '../sqlite.js';
import {isKiroRefreshable, isKiroTokenFresh, parseKiroAuthRecords, type KiroAuth} from './authRecords.js';

// kiro-cli spells its OIDC keys "odic".
const TOKEN_QUERY = "SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'";
const REGISTRATION_QUERY = "SELECT value FROM auth_kv WHERE key = 'kirocli:odic:device-registration'";
// The state table declares its values as BLOB, which libgda only returns as text through a cast.
const PROFILE_QUERY = "SELECT CAST(value AS TEXT) FROM state WHERE key = 'api.codewhisperer.profile'";

export async function kiroDatabaseStamp(path: string, cancellable: Gio.Cancellable | null): Promise<string> {
    const stamp = await databaseStamp(path, cancellable);
    if (stamp === null)
        throw new CollectorError('auth-missing', ({_}) => _('kiro-cli is not signed in.'));
    return stamp;
}

export function readKiroAuth(path: string, cancellable: Gio.Cancellable | null): Promise<KiroAuth> {
    return readDatabase(path, 'Kiro', cancellable, select => parseKiroAuthRecords({
        token: select(TOKEN_QUERY),
        registration: select(REGISTRATION_QUERY),
        profile: select(PROFILE_QUERY),
    }), () => new CollectorError('auth-invalid', ({_}) => formatText(_('The kiro-cli database at %s could not be read.'), displayPath(path))));
}

export async function kiroCredentialStatus(instance: ProviderInstance, cancellable: Gio.Cancellable | null): Promise<CredentialStatus> {
    const path = providerPaths(instance).authFile;
    let auth: KiroAuth;
    try {
        await kiroDatabaseStamp(path, cancellable);
        auth = await readKiroAuth(path, cancellable);
    } catch (error) {
        return credentialErrorStatus(error);
    }
    if (isKiroTokenFresh(auth))
        return 'authenticated';
    return isKiroRefreshable(auth) ? 'expired-refreshable' : 'login-required';
}
