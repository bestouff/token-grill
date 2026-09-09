import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {CollectorError} from '../../core/errors.js';
import {providerPaths} from '../../core/paths.js';
import type {ProviderInstance} from '../../core/types.js';
import {isCancellation} from '../../storage/atomicJson.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

export interface CodexAuth {accessToken: string; accountId: string | null; path: string}

export async function loadCodexAuth(instance: ProviderInstance, cancellable: Gio.Cancellable | null = null): Promise<CodexAuth> {
    const path = providerPaths(instance).authFile;
    try {
        const file = Gio.File.new_for_path(path);
        const info = await file.query_info_async('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR) throw new CollectorError('Codex authentication file is not a regular file.', 'auth-invalid');
        if (info.get_size() > 1024 * 1024) throw new CollectorError('Codex authentication file is unexpectedly large.', 'auth-invalid');
        const [bytes] = await file.load_contents_async(cancellable);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const tokens = payload.tokens as Record<string, unknown> | undefined;
        const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token.replace(/^Bearer\s+/i, '').trim() : '';
        if (!accessToken) throw new CollectorError('No Codex access token was found.', 'auth-missing');
        const {expiresAt} = tokenFromJwt(accessToken);
        if (expiresAt !== null && expiresAt * 1000 <= Date.now()) throw new CollectorError('Codex authentication has expired. Run Codex login.', 'auth-expired');
        return {accessToken, accountId: typeof tokens?.account_id === 'string' ? tokens.account_id : null, path};
    } catch (error) {
        if (isCancellation(error)) throw error;
        if (error instanceof CollectorError) throw error;
        throw new CollectorError(`Codex authentication was not found at ${path}.`, 'auth-missing');
    }
}

export function tokenFromJwt(token: string): {expiresAt: number | null} {
    const parts = token.split('.');
    if (parts.length !== 3) return {expiresAt: null};
    try {
        const encoded = parts[1] || '';
        const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
        const bytes = GLib.base64_decode(normalized);
        const claims = JSON.parse(new TextDecoder().decode(bytes)) as {exp?: number};
        return {expiresAt: typeof claims.exp === 'number' ? claims.exp : null};
    } catch { return {expiresAt: null}; }
}
