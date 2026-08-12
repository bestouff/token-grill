import Gio from 'gi://Gio';
import type {ProviderInstance} from '../../core/types.js';
import {providerPaths} from '../../core/paths.js';
import {CollectorError} from '../../core/errors.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

export interface ClaudeAuth {sessionKey: string; organizationId: string | null; path: string}

export async function loadClaudeAuth(instance: ProviderInstance): Promise<ClaudeAuth> {
    const path = providerPaths(instance).authFile;
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() !== Gio.FileType.REGULAR) throw new CollectorError('Claude credentials are not a regular file.', 'auth-invalid');
        if (info.get_size() > 1024 * 1024) throw new CollectorError('Claude credentials file is unexpectedly large.', 'auth-invalid');
        const [bytes] = await file.load_contents_async(null);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const oauth = payload.claudeAiOauth && typeof payload.claudeAiOauth === 'object' ? payload.claudeAiOauth as Record<string, unknown> : {};
        const sessionKey = typeof oauth.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : typeof payload.sessionKey === 'string' ? payload.sessionKey : typeof payload.oauthToken === 'string' ? payload.oauthToken : '';
        if (!sessionKey) throw new CollectorError('No Claude live access token was found. Run Claude login.', 'auth-missing');
        const rawExpiry = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
        const expiresAt = rawExpiry !== null && rawExpiry < 10000000000 ? rawExpiry * 1000 : rawExpiry;
        if (expiresAt !== null && expiresAt <= Date.now()) throw new CollectorError('Claude authentication has expired. Run Claude login.', 'auth-expired');
        const organizationId = typeof oauth.organizationId === 'string' ? oauth.organizationId : typeof payload.organizationId === 'string' ? payload.organizationId : null;
        return {sessionKey, organizationId, path};
    } catch (error) {
        if (error instanceof CollectorError) throw error;
        throw new CollectorError(`Claude authentication was not found at ${path}.`, 'auth-missing');
    }
}
