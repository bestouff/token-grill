import type Gio from 'gi://Gio';

import {CollectorError} from '../../core/errors.js';
import {formatText} from '../../core/i18n.js';
import {stringAt} from '../../core/json.js';
import {displayPath, providerPaths} from '../../core/paths.js';
import type {ProviderInstance} from '../../core/types.js';
import {credentialErrorStatus, readCredentialJson, type CredentialStatus} from '../credentials.js';
import {jwtExpiry, jwtSubject} from '../jwt.js';
import {databaseStamp, readDatabase} from '../sqlite.js';
import {isJwtLike} from './normalize.js';

// ItemTable declares its values as BLOB, which libgda only returns as text through a cast.
const TOKEN_QUERY = "SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = 'cursorAuth/accessToken'";
const EMAIL_QUERY = "SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = 'cursorAuth/cachedEmail'";

export interface CursorAuth {
    accessToken: string;
    // The account the token belongs to, from its `sub` claim.
    subject: string | null;
    email: string | null;
    expiresAt: number | null;
}

function notSignedIn(): CollectorError {
    return new CollectorError('auth-missing', ({_}) => _('Cursor is not signed in.'));
}

// Newer Cursor builds encrypt the stored token with a key from the system
// keyring. Token Grill does not decrypt another app's secrets.
function cursorAuth(accessToken: string, email: string | null): CursorAuth {
    if (!isJwtLike(accessToken))
        throw new CollectorError('unsupported-account', ({_}) => _('Cursor keeps this sign-in encrypted, so Token Grill cannot read it.'));
    return {accessToken, subject: jwtSubject(accessToken), email, expiresAt: jwtExpiry(accessToken)};
}

export async function cursorDatabaseStamp(path: string, cancellable: Gio.Cancellable | null): Promise<string> {
    const stamp = await databaseStamp(path, cancellable);
    if (stamp === null)
        throw notSignedIn();
    return stamp;
}

// Cursor renews its own sign-in while it runs; Token Grill only reads it.
export function readCursorAuth(path: string, cancellable: Gio.Cancellable | null): Promise<CursorAuth> {
    return readDatabase(path, 'Cursor', cancellable, select => {
        const accessToken = select(TOKEN_QUERY);
        if (!accessToken)
            throw notSignedIn();
        return cursorAuth(accessToken, select(EMAIL_QUERY) || null);
    }, () => new CollectorError('auth-invalid', ({_}) => formatText(_('The Cursor database at %s could not be read.'), displayPath(path))));
}

// `agent login` keeps its sign-in in a file of its own; the CLI renews it.
export async function readCursorAgentAuth(path: string, cancellable: Gio.Cancellable | null): Promise<CursorAuth> {
    const accessToken = stringAt(await readCredentialJson(path, cancellable), 'accessToken');
    if (!accessToken)
        throw new CollectorError('auth-missing', ({_}) => _('The Cursor CLI is not signed in.'));
    return cursorAuth(accessToken, null);
}

export function isCursorTokenFresh(auth: CursorAuth): boolean {
    return auth.expiresAt === null || auth.expiresAt > Date.now();
}

export async function cursorCredentialStatus(instance: ProviderInstance, cancellable: Gio.Cancellable | null): Promise<CredentialStatus> {
    const path = providerPaths(instance).authFile;
    let auth: CursorAuth;
    try {
        if (instance.app === 'cursor-agent') {
            auth = await readCursorAgentAuth(path, cancellable);
        } else {
            await cursorDatabaseStamp(path, cancellable);
            auth = await readCursorAuth(path, cancellable);
        }
    } catch (error) {
        return credentialErrorStatus(error);
    }
    return isCursorTokenFresh(auth) ? 'authenticated' : 'login-required';
}
