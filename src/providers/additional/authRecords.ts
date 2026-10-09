import {record} from './normalize.js';

export function apiKeyFromRecord(payload: unknown, keys: string[]): string | null {
    const root = record(payload);
    for (const key of keys) {
        const entry = record(root[key]);
        if (entry.type === 'api' && typeof entry.key === 'string' && entry.key.trim()) return entry.key.trim();
    }
    // Explicit credential files may contain a single API key instead of an OpenCode map.
    const direct = root.api_key ?? root.apiKey ?? root.key;
    return typeof direct === 'string' && direct.trim() ? direct.trim() : null;
}

export interface KimiAccountConfig {baseUrl: string; credentialName: string; apiKey: string | null}

export function kimiAccountConfig(config: unknown): KimiAccountConfig {
    const provider = record(record(record(config).providers)['managed:kimi-code']);
    const baseUrl = String(provider.base_url ?? provider.baseUrl ?? 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
    if (!['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'].includes(baseUrl))
        throw new Error('Kimi Code requires an official regional API endpoint.');
    const oauth = record(provider.oauth);
    const key = typeof oauth.key === 'string' ? oauth.key : 'oauth/kimi-code';
    const credentialName = key.replace(/^oauth\//, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(credentialName)) throw new Error('Kimi credential reference is invalid.');
    const apiKey = typeof provider.api_key === 'string' ? provider.api_key : typeof provider.apiKey === 'string' ? provider.apiKey : null;
    return {baseUrl, credentialName, apiKey};
}
