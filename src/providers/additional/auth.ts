import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parse} from 'smol-toml';
import {CollectorError} from '../../core/errors.js';
import {expandPath, providerPaths} from '../../core/paths.js';
import type {ProviderInstance} from '../../core/types.js';
import {isCancellation} from '../../storage/atomicJson.js';
import {apiKeyFromRecord, kimiAccountConfig} from './authRecords.js';
import {record} from './normalize.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

async function readCredentialFile(path: string, cancellable: Gio.Cancellable): Promise<string> {
    try {
        const file = Gio.File.new_for_path(path);
        const info = await file.query_info_async('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 1024 * 1024)
            throw new CollectorError('The credential file must be a regular file smaller than 1 MiB.', 'auth-invalid');
        const [bytes] = await file.load_contents_async(cancellable);
        if (bytes.length > 1024 * 1024) throw new CollectorError('The credential file is too large.', 'auth-invalid');
        return new TextDecoder().decode(bytes);
    } catch (error) {
        if (isCancellation(error) || error instanceof CollectorError) throw error;
        throw new CollectorError(`Credentials could not be read at ${path}.`, 'auth-missing');
    }
}

function credentialJson(text: string): unknown {
    try { return JSON.parse(text); }
    catch { throw new CollectorError('The credential file is not valid JSON.', 'auth-invalid'); }
}

export async function loadApiKey(instance: ProviderInstance, cancellable: Gio.Cancellable): Promise<string> {
    const payload = credentialJson(await readCredentialFile(providerPaths(instance).authFile, cancellable));
    const keys = instance.kind === 'deepseek' ? ['deepseek'] : ['opencode-go', 'opencode'];
    const key = apiKeyFromRecord(payload, keys);
    if (!key) throw new CollectorError(`No ${instance.kind === 'deepseek' ? 'DeepSeek' : 'OpenCode Zen / Go'} API key found. Run opencode auth login or select a JSON API key file in Preferences.`, 'auth-missing');
    return key;
}

export async function loadKimiAuth(instance: ProviderInstance, cancellable: Gio.Cancellable): Promise<{token: string; baseUrl: string}> {
    const paths = providerPaths(instance);
    let config: unknown = {};
    if (Gio.File.new_for_path(paths.configFile).query_exists(null)) {
        try { config = parse(await readCredentialFile(paths.configFile, cancellable)); }
        catch (error) {
            if (isCancellation(error) || error instanceof CollectorError) throw error;
            throw new CollectorError('The Kimi configuration is not valid TOML.', 'auth-invalid');
        }
    }
    let account;
    try { account = kimiAccountConfig(config); }
    catch { throw new CollectorError('The Kimi configuration has an unsupported endpoint or credential reference.', 'auth-invalid'); }
    if (account.apiKey && !instance.authFileOverride) return {token: account.apiKey, baseUrl: account.baseUrl};
    const path = instance.authFileOverride ? paths.authFile : GLib.build_filenamev([expandPath(instance.accountHome), 'credentials', `${account.credentialName}.json`]);
    const payload = record(credentialJson(await readCredentialFile(path, cancellable)));
    const apiKey = apiKeyFromRecord(payload, ['kimi-for-coding']);
    if (apiKey) return {token: apiKey, baseUrl: account.baseUrl};
    const token = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    if (!token) throw new CollectorError('No Kimi Code token found. Start kimi and run /login.', 'auth-missing');
    if (typeof payload.expires_at !== 'number' || !Number.isFinite(payload.expires_at) || payload.expires_at * 1000 <= Date.now())
        throw new CollectorError('Kimi Code authentication has expired. Start kimi and run /login to refresh it.', 'auth-expired');
    return {token, baseUrl: account.baseUrl};
}
