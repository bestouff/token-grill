// @ts-nocheck
import GLib from 'gi://GLib';
import {CollectorError} from '../../core/errors.js';
import {providerPaths} from '../../core/paths.js';
import type {ProviderInstance} from '../../core/types.js';
import {isKiroTokenFresh, parseKiroAuthRecords, type KiroAuth} from './authRecords.js';
export {isKiroTokenFresh, type KiroAuth} from './authRecords.js';

function queryValue(connection, table: string, key: string): string | null {
    const model = connection.execute_select_command(`SELECT value FROM ${table} WHERE key = '${key}' LIMIT 1`);
    if (!model || model.get_n_rows() < 1) return null;
    const value = model.get_value_at(0, 0);
    return value === null || value === undefined ? null : String(value);
}

function optionalQueryValue(connection, table: string, key: string): string | null {
    try { return queryValue(connection, table, key); } catch { return null; }
}

export async function loadKiroAuth(instance: ProviderInstance): Promise<KiroAuth> {
    const path = providerPaths(instance).authFile;
    let connection = null;
    try {
        const module = await import('gi://Gda?version=5.0');
        const Gda = module.default;
        Gda.init();
        connection = Gda.Connection.open_from_string(
            'SQLite',
            `DB_DIR=${GLib.path_get_dirname(path)};DB_NAME=${GLib.path_get_basename(path)}`,
            null,
            Gda.ConnectionOptions.READ_ONLY,
        );
        // libgda's READ_ONLY flag is advisory for some SQLite provider builds.
        // SQLite's connection-local query_only guard makes write statements fail.
        connection.execute_select_command('PRAGMA query_only = ON');
        const tokenRaw = queryValue(connection, 'auth_kv', 'kirocli:odic:token');
        if (!tokenRaw) throw new CollectorError('No active Kiro CLI login was found. Run kiro-cli login.', 'auth-missing');
        const registrationRaw = queryValue(connection, 'auth_kv', 'kirocli:odic:device-registration');
        const profileRaw = optionalQueryValue(connection, 'state', 'api.codewhisperer.profile');
        return parseKiroAuthRecords(tokenRaw, registrationRaw, profileRaw, path);
    } catch (error) {
        if (error instanceof CollectorError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (/Gda|typelib|namespace/i.test(message)) throw new CollectorError('Kiro support requires the Gda 5.0 SQLite binding.', 'dependency');
        if (/no such table|database|SQLite|open/i.test(message)) throw new CollectorError(`The Kiro CLI data store could not be read at ${path}.`, 'auth-invalid');
        throw new CollectorError(`Kiro authentication was not found at ${path}.`, 'auth-missing');
    } finally {
        try { connection?.close(); } catch { /* read-only connection cleanup */ }
    }
}

export async function kiroCredentialStatus(instance: ProviderInstance): Promise<'authenticated' | 'expired-refreshable' | 'login-required' | 'database-unreadable' | 'dependency-missing'> {
    try {
        const auth = await loadKiroAuth(instance);
        if (isKiroTokenFresh(auth)) return 'authenticated';
        return auth.refreshToken && auth.clientId && auth.clientSecret && (auth.clientSecretExpiresAt === null || auth.clientSecretExpiresAt > Date.now())
            ? 'expired-refreshable' : 'login-required';
    } catch (error) {
        if (error instanceof CollectorError && error.code === 'dependency') return 'dependency-missing';
        if (error instanceof CollectorError && error.code === 'auth-missing') return 'login-required';
        return 'database-unreadable';
    }
}
