import {CollectorError, NO_USAGE} from '../../core/errors.js';
import type {ProviderInstance, ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext, type LimitsUpdate} from '../base.js';
import {loadClaudeAccessToken} from './auth.js';
import {claudeUsageEvent} from './history.js';
import {normalizeClaudeUsage} from './normalize.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

async function fetchLimits(instance: ProviderInstance, context: CollectorContext): Promise<LimitsUpdate> {
    const accessToken = await loadClaudeAccessToken(instance, context.cancellable);
    const payload = await context.requestJson('GET', USAGE_URL, {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
    });
    const windows = normalizeClaudeUsage(payload);
    if (!windows.length)
        throw new CollectorError('response-shape', NO_USAGE);
    return {windows};
}

export class ClaudeCollector extends BaseCollector {
    async collect(instance: ProviderInstance, context: CollectorContext, snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
        let next = snapshot;
        if (instance.liveUsageEnabled)
            next = await this.collectLimits(context, next, () => fetchLimits(instance, context));
        if (instance.localHistoryEnabled)
            next = await this.collectHistory(instance, context, next, claudeUsageEvent);
        return next;
    }
}
