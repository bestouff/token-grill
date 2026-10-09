import {CollectorError} from '../../core/errors.js';
import {emptySnapshot, type ProviderInstance, type ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext} from '../base.js';
import {loadApiKey, loadKimiAuth} from './auth.js';
import {normalizeDeepSeekBalance, normalizeKimiUsage, normalizeOpenCodeUsage} from './normalize.js';

export class AdditionalProviderCollector extends BaseCollector {
    async collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled) return previous || emptySnapshot(instance.id);
        try {
            const auth = instance.kind === 'kimi' ? await loadKimiAuth(instance, context.cancellable) :
                {token: await loadApiKey(instance, context.cancellable), baseUrl: ''};
            const url = instance.kind === 'deepseek' ? 'https://api.deepseek.com/user/balance' :
                instance.kind === 'kimi' ? `${auth.baseUrl}/usages` : 'https://opencode.ai/zen/go/v1/usage';
            const payload = await context.getJson(context.session, url, {Authorization: `Bearer ${auth.token}`, Accept: 'application/json'});
            const balances = instance.kind === 'deepseek' ? normalizeDeepSeekBalance(payload) : [];
            const windows = instance.kind === 'kimi' ? normalizeKimiUsage(payload) : instance.kind === 'opencode' ? normalizeOpenCodeUsage(payload) : [];
            if (!balances.length && !windows.length) throw new CollectorError('The provider response contained no recognized balance or quota data.', 'response-shape');
            const now = Date.now();
            context.onSourceResult?.('limits', 'success');
            return {...(previous || emptySnapshot(instance.id)), state: 'ready', lastUpdated: now, quotaFetchedAt: now,
                error: null, errorInfo: null, windows, balances,
                plan: instance.kind === 'deepseek' ? 'Prepaid API' : instance.kind === 'opencode' ? 'Go subscription' : 'Code subscription'};
        } catch (error) {
            context.onSourceResult?.('limits', 'failed');
            return this.failed(instance, previous, error);
        }
    }
}
