// DeepSeek is prepaid: the documented GET /user/balance returns money left,
// {is_available, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}]}.
import {CollectorError, NO_USAGE} from '../../core/errors.js';
import {isRecord, numberOrNumericString, recordAt, stringAt} from '../../core/json.js';
import type {Balance} from '../../core/types.js';

export function normalizeDeepSeekBalance(payload: unknown): Balance {
    const infos = isRecord(payload) && Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
    for (const info of infos) {
        const total = isRecord(info) ? numberOrNumericString(info.total_balance) : null;
        const currency = isRecord(info) ? stringAt(info, 'currency') : null;
        // Intl.NumberFormat throws on anything that is not an ISO 4217 code.
        if (total !== null && currency && /^[A-Z]{3}$/.test(currency))
            return {amount: total, currency};
    }
    throw new CollectorError('response-shape', NO_USAGE);
}

// Claude Code can be pointed at DeepSeek's Anthropic-compatible API; its key then
// sits in settings.json next to the DeepSeek base URL.
export function deepSeekKeyFromClaudeSettings(settings: Record<string, unknown>): string | null {
    const env = recordAt(settings, 'env');
    const baseUrl = env ? stringAt(env, 'ANTHROPIC_BASE_URL') : null;
    const token = env ? stringAt(env, 'ANTHROPIC_AUTH_TOKEN') : null;
    const host = baseUrl?.match(/^https:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase() ?? '';
    return token && (host === 'deepseek.com' || host.endsWith('.deepseek.com')) ? token : null;
}
