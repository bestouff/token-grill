import type {CollectorContext} from '../base.js';
import {loadCodexAuth} from './auth.js';
import {normalizeResetCredits} from './resetCreditsNormalize.js';
import type {ProviderInstance, ProviderSnapshot} from '../../core/types.js';
import {CollectorError} from '../../core/errors.js';
import {isCancellation} from '../../storage/atomicJson.js';

const BASE = 'https://chatgpt.com';
const PATH = '/backend-api/wham/rate-limit-reset-credits';

export async function collectCodexResetCredits(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null) {
    if (!instance.liveUsageEnabled) return previous?.resetCredits ?? null;
    try {
        const auth = await loadCodexAuth(instance, context.cancellable);
        const payload = await context.getJson(context.session, `${BASE}${PATH}`, {
            Accept: '*/*',
            Authorization: `Bearer ${auth.accessToken}`,
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            Referer: `${BASE}/codex/cloud/settings/analytics`,
            'oai-language': 'en-US',
            'x-openai-target-path': PATH,
            'x-openai-target-route': PATH,
        });
        const normalized = normalizeResetCredits(payload);
        if (!normalized) throw new CollectorError('Reset-credit response shape was unavailable.', 'response-shape');
        return normalized;
    } catch (error) {
        if (isCancellation(error)) throw error;
        const cached = previous?.resetCredits;
        if (cached) return {...cached, stale: true, error: {
            code: 'http' as const, message: error instanceof Error ? error.message : 'Reset credits unavailable.', recovery: 'retry' as const, occurredAt: Date.now(), retryAt: null,
        }};
        throw error;
    }
}
