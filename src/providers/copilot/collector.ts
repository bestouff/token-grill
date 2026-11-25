import type {ProviderInstance, ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext, type LimitsUpdate} from '../base.js';
import {loadCopilotToken} from './auth.js';
import {normalizeCopilotUsage} from './normalize.js';

// The usage counters GitHub's own Copilot settings page shows.
const USAGE_URL = 'https://api.github.com/copilot_internal/user';

async function fetchLimits(instance: ProviderInstance, context: CollectorContext): Promise<LimitsUpdate> {
    const token = await loadCopilotToken(instance, context.cancellable);
    const payload = await context.requestJson('GET', USAGE_URL, {
        Accept: 'application/json',
        Authorization: `token ${token}`,
    });
    const {windows, plan} = normalizeCopilotUsage(payload);
    return {windows, plan};
}

export class CopilotCollector extends BaseCollector {
    collect(instance: ProviderInstance, context: CollectorContext, snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled)
            return Promise.resolve(snapshot);
        return this.collectLimits(context, snapshot, () => fetchLimits(instance, context));
    }
}
