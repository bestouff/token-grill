import {CollectorError} from '../../core/errors.js';
import type {ProviderSnapshot} from '../../core/types.js';
import {emptySnapshot} from '../../core/types.js';
import {loadCodexAuth} from './auth.js';
import {normalizeCodexUsage} from './normalize.js';
import {BaseCollector, type CollectorContext} from '../base.js';
import type {ProviderInstance} from '../../core/types.js';

const BASE = 'https://chatgpt.com';

export class CodexUsageCollector extends BaseCollector {
    async collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled) return previous || emptySnapshot(instance.id);
        try {
            const auth = await loadCodexAuth(instance, context.cancellable);
            const payload = await context.getJson(context.session, `${BASE}/backend-api/wham/usage`, {
                Accept: '*/*',
                Authorization: `Bearer ${auth.accessToken}`,
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
                Referer: `${BASE}/codex/cloud/settings/analytics`,
                'oai-language': 'en-US',
                'x-openai-target-path': '/backend-api/wham/usage',
                'x-openai-target-route': '/backend-api/wham/usage',
            });
            const normalized = normalizeCodexUsage(payload);
            if (!normalized.windows.length) throw new CollectorError('The Codex response did not contain quota windows.', 'response-shape');
            return {
                ...(previous || emptySnapshot(instance.id)),
                providerId: instance.id,
                state: 'ready',
                lastUpdated: Date.now(),
                quotaFetchedAt: Date.now(),
                error: null,
                errorInfo: null,
                plan: normalized.plan,
                windows: normalized.windows,
            };
        } catch (error) {
            return this.failed(instance, previous, error);
        }
    }
}
