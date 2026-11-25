import {CollectorError, isTransientError, NO_USAGE} from '../../core/errors.js';
import {isRecord, numberAt, stringAt} from '../../core/json.js';
import type {ProviderInstance, ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext, type LimitsUpdate} from '../base.js';
import {isAntigravityRefreshable, isAntigravityTokenFresh, resolveAntigravityAuth, type AntigravityAuth} from './auth.js';
import {GOOGLE_OAUTH_TOKEN_URL, LOAD_CODE_ASSIST_URL, RETRIEVE_USER_QUOTA_SUMMARY_URL} from './endpoints.js';
import {antigravityPlan, normalizeQuotaSummary} from './normalize.js';

function authExpired(auth: AntigravityAuth): CollectorError {
    if (auth.source === 'keyring')
        return new CollectorError('auth-expired', ({_}) => _('The agy sign-in has expired.'));
    return new CollectorError('auth-expired', ({_}) => _('The Antigravity sign-in has expired.'));
}

export class AntigravityCollector extends BaseCollector {
    // Tokens refreshed here, so the stored refresh token is not used on every pass.
    private readonly _refreshed = new Map<string, AntigravityAuth>();

    collect(instance: ProviderInstance, context: CollectorContext, snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled)
            return Promise.resolve(snapshot);
        return this.collectLimits(context, snapshot, () => this._fetchLimits(instance, context));
    }

    private async _fetchLimits(instance: ProviderInstance, context: CollectorContext): Promise<LimitsUpdate> {
        const auth = await this._freshAuth(instance, context);
        const headers = {
            Accept: 'application/json',
            Authorization: `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json',
        };
        // The tier only names the plan; the usage limits must not depend on it.
        const assist = context.requestJson('POST', LOAD_CODE_ASSIST_URL, headers, {}).catch((error: unknown) => {
            if (error instanceof CollectorError && !isTransientError(error) && error.code !== 'auth-invalid')
                return null;
            throw error;
        });
        const [assistPayload, summaryPayload] = await Promise.all([assist, context.requestJson('POST', RETRIEVE_USER_QUOTA_SUMMARY_URL, headers, {})]);
        const windows = normalizeQuotaSummary(summaryPayload);
        if (!windows.length)
            throw new CollectorError('response-shape', NO_USAGE);
        return {plan: antigravityPlan(assistPayload), windows};
    }

    private async _freshAuth(instance: ProviderInstance, context: CollectorContext): Promise<AntigravityAuth> {
        const stored = await resolveAntigravityAuth(instance, context.cancellable);
        const refreshed = this._refreshed.get(instance.id);
        // A refreshed token only stands in for the same credential, so switching accounts never reuses it.
        if (refreshed && refreshed.source === stored.source && refreshed.refreshToken === stored.refreshToken && isAntigravityTokenFresh(refreshed))
            return refreshed;
        if (isAntigravityTokenFresh(stored))
            return stored;
        if (!isAntigravityRefreshable(stored))
            throw authExpired(stored);
        let payload: unknown;
        try {
            payload = await context.requestJson('POST', GOOGLE_OAUTH_TOKEN_URL, {'Content-Type': 'application/json'}, {
                client_id: stored.clientId,
                client_secret: stored.clientSecret,
                refresh_token: stored.refreshToken,
                grant_type: 'refresh_token',
            });
        } catch (error) {
            if (!(error instanceof CollectorError) || isTransientError(error))
                throw error;
            throw authExpired(stored);
        }
        const accessToken = isRecord(payload) ? stringAt(payload, 'access_token') : null;
        const expiresIn = isRecord(payload) ? numberAt(payload, 'expires_in') : null;
        if (!accessToken || expiresIn === null)
            throw authExpired(stored);
        const auth = {...stored, accessToken, expiresAt: Date.now() + expiresIn * 1000};
        this._refreshed.set(instance.id, auth);
        return auth;
    }
}
