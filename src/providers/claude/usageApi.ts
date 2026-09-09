import type {ProviderSnapshot} from '../../core/types.js';
import {emptySnapshot} from '../../core/types.js';
import {loadClaudeAuth} from './auth.js';
import {normalizeClaudeUsage} from './normalize.js';
import {BaseCollector, type CollectorContext} from '../base.js';
import type {ProviderInstance} from '../../core/types.js';

const BASE = 'https://api.anthropic.com';

export class ClaudeUsageCollector extends BaseCollector {
    async collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled) return previous || emptySnapshot(instance.id);
        try {
            const auth = await loadClaudeAuth(instance, context.cancellable);
            const payload = await context.getJson(context.session, `${BASE}/api/oauth/usage`, {
                Accept: 'application/json',
                Authorization: `Bearer ${auth.sessionKey}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'User-Agent': 'Token Grill',
            });
            const windows = normalizeClaudeUsage(payload);
            if (!windows.length) throw new Error('Claude returned no recognized usage windows.');
            return {
                ...(previous || emptySnapshot(instance.id)),
                providerId: instance.id,
                state: 'ready',
                lastUpdated: Date.now(),
                quotaFetchedAt: Date.now(),
                error: null,
                errorInfo: null,
                windows,
            };
        } catch (error) {
            return this.failed(instance, previous, error);
        }
    }
}
