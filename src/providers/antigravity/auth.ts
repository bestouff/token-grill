import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type {ProviderInstance} from '../../core/types.js';
import {providerPaths, pathExists} from '../../core/paths.js';
import {CollectorError} from '../../core/errors.js';
import {isCancellation} from '../../storage/atomicJson.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

export interface AntigravityAuth {
    clientId: string | null;
    clientSecret: string | null;
    refreshToken: string | null;
    accessToken: string | null;
    expiresAt: number | null;
    projectId: string | null;
    path: string;
}

export function isAntigravityTokenFresh(auth: AntigravityAuth): boolean {
    return Boolean(auth.accessToken && auth.expiresAt !== null && auth.expiresAt > Date.now() + 60_000);
}

function resolveCandidateAuthFile(instance: ProviderInstance): string {
    const defaultPath = providerPaths(instance).authFile;
    if (pathExists(defaultPath)) return defaultPath;

    // Check fallback locations if the default path doesn't exist
    const home = GLib.get_home_dir();
    const candidates = [
        GLib.build_filenamev([home, '.gemini', 'antigravity', 'acp_token.json']),
        GLib.build_filenamev([home, '.antigravity', 'acp_token.json']),
        GLib.build_filenamev([home, '.antigravity', 'oauth_creds.json']),
    ];

    for (const candidate of candidates) {
        if (pathExists(candidate)) return candidate;
    }

    // Also check ~/.t3/userdata/providers/antigravity/*/antigravity-acp/acp_token.json
    try {
        const t3Dir = Gio.File.new_for_path(GLib.build_filenamev([home, '.t3', 'userdata', 'providers', 'antigravity']));
        if (t3Dir.query_exists(null)) {
            const enumerator = t3Dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null))) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
                const tokenFile = GLib.build_filenamev([home, '.t3', 'userdata', 'providers', 'antigravity', info.get_name(), 'antigravity-acp', 'acp_token.json']);
                if (pathExists(tokenFile)) return tokenFile;
            }
        }
    } catch {
        // Ignore enumeration errors
    }

    return defaultPath;
}

export async function loadAntigravityAuth(instance: ProviderInstance, cancellable: Gio.Cancellable | null = null): Promise<AntigravityAuth> {
    const path = resolveCandidateAuthFile(instance);
    try {
        const file = Gio.File.new_for_path(path);
        const info = await file.query_info_async('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR) throw new CollectorError('Antigravity credentials are not a regular file.', 'auth-invalid');
        if (info.get_size() > 1024 * 1024) throw new CollectorError('Antigravity credentials file is unexpectedly large.', 'auth-invalid');
        const [bytes] = await file.load_contents_async(cancellable);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

        const clientId = typeof payload.client_id === 'string' ? payload.client_id : typeof payload.clientId === 'string' ? payload.clientId : null;
        const clientSecret = typeof payload.client_secret === 'string' ? payload.client_secret : typeof payload.clientSecret === 'string' ? payload.clientSecret : null;
        const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : typeof payload.refreshToken === 'string' ? payload.refreshToken : null;
        const accessToken = typeof payload.access_token === 'string' ? payload.access_token : typeof payload.accessToken === 'string' ? payload.accessToken : null;
        const projectId = typeof payload.project_id === 'string' ? payload.project_id : typeof payload.projectId === 'string' ? payload.projectId : 'aicode-consumers';

        let expiresAt: number | null = null;
        if (typeof payload.expiry_date === 'number') {
            expiresAt = payload.expiry_date < 10000000000 ? payload.expiry_date * 1000 : payload.expiry_date;
        } else if (typeof payload.expiresAt === 'number') {
            expiresAt = payload.expiresAt < 10000000000 ? payload.expiresAt * 1000 : payload.expiresAt;
        } else if (typeof payload.expires_at === 'number') {
            expiresAt = payload.expires_at < 10000000000 ? payload.expires_at * 1000 : payload.expires_at;
        }

        if (!accessToken && !refreshToken) {
            throw new CollectorError('No Antigravity access token or refresh token found. Ensure Antigravity is logged in.', 'auth-missing');
        }

        return {clientId, clientSecret, refreshToken, accessToken, expiresAt, projectId, path};
    } catch (error) {
        if (isCancellation(error)) throw error;
        if (error instanceof CollectorError) throw error;
        throw new CollectorError(`Antigravity authentication was not found at ${path}.`, 'auth-missing');
    }
}

export async function antigravityCredentialStatus(instance: ProviderInstance): Promise<'authenticated' | 'expired-refreshable' | 'login-required' | 'database-unreadable' | 'dependency-missing'> {
    try {
        const auth = await loadAntigravityAuth(instance);
        if (isAntigravityTokenFresh(auth)) return 'authenticated';
        if (auth.refreshToken && auth.clientId && auth.clientSecret) return 'expired-refreshable';
        return 'login-required';
    } catch (error) {
        if (error instanceof CollectorError && error.code === 'auth-missing') return 'login-required';
        return 'database-unreadable';
    }
}
