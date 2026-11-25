import {CollectorError, NO_USAGE, providerErrorInfo} from '../../core/errors.js';
import type {LimitResetCreditSummary, ProviderInstance, ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext} from '../base.js';
import {loadCodexAccessToken} from './auth.js';
import {codexUsageEvent} from './history.js';
import {normalizeCodexUsage, type CodexUsage} from './normalize.js';
import {normalizeResetCredits} from './resetCreditsNormalize.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

function requestHeaders(accessToken: string): Record<string, string> {
    return {'Accept': 'application/json', 'Authorization': `Bearer ${accessToken}`};
}

export class CodexCollector extends BaseCollector {
    async collect(instance: ProviderInstance, context: CollectorContext, snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
        let next = snapshot;
        if (instance.liveUsageEnabled)
            next = await this._collectLive(instance, context, next);
        if (instance.localHistoryEnabled)
            next = await this.collectHistory(instance, context, next, codexUsageEvent);
        return next;
    }

    private async _collectLive(instance: ProviderInstance, context: CollectorContext, snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
        let accessToken: string;
        let usage: CodexUsage;
        try {
            accessToken = await loadCodexAccessToken(instance, context.cancellable);
            usage = normalizeCodexUsage(await context.requestJson('GET', USAGE_URL, requestHeaders(accessToken)));
            if (!usage.windows.length)
                throw new CollectorError('response-shape', NO_USAGE);
        } catch (error) {
            return this.limitsFailed(context, snapshot, error);
        }
        const ready = this.limitsReady(context, snapshot, {plan: usage.plan, windows: usage.windows});
        return {...ready, resetCredits: await this._resetCredits(accessToken, context, snapshot.resetCredits)};
    }

    // Reset credits are optional: when they cannot be fetched, the last known
    // list stays visible, marked stale, and the usage limits remain valid.
    private async _resetCredits(
        accessToken: string,
        context: CollectorContext,
        cached: LimitResetCreditSummary | null
    ): Promise<LimitResetCreditSummary | null> {
        context.onSourcePhase('reset-credits');
        try {
            const summary = normalizeResetCredits(await context.requestJson('GET', RESET_CREDITS_URL, requestHeaders(accessToken)));
            if (!summary)
                throw new CollectorError('response-shape', ({_}) => _('The service response did not contain reset credits.'));
            context.onSourceResult('reset-credits', 'success');
            return summary;
        } catch (error) {
            if (!(error instanceof CollectorError))
                throw error;
            context.onSourceResult('reset-credits', 'failed');
            return cached && {...cached, stale: true, error: providerErrorInfo(error)};
        }
    }
}
