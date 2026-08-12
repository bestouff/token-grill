import {CollectorError} from '../../core/errors.js';
import {emptySnapshot, type ProviderInstance, type ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext} from '../base.js';
import {isKiroTokenFresh, loadKiroAuth, type KiroAuth} from './auth.js';
import {kiroOidcEndpoint, kiroUsageUrl} from './endpoints.js';
import {normalizeKiroUsage} from './normalize.js';

function text(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null;
}

export class KiroUsageCollector extends BaseCollector {
    private readonly cachedAuth = new Map<string, KiroAuth>();

    private async auth(instance: ProviderInstance, context: CollectorContext): Promise<KiroAuth> {
        const stored = await loadKiroAuth(instance);
        const cached = this.cachedAuth.get(instance.id);
        let auth = cached && cached.path === stored.path && cached.clientId === stored.clientId && cached.expiresAt >= stored.expiresAt ? cached : stored;
        if (isKiroTokenFresh(auth)) return auth;
        if (!auth.refreshToken || !auth.clientId || !auth.clientSecret)
            throw new CollectorError('Kiro authentication has expired. Run kiro-cli login.', 'auth-expired');
        if (auth.clientSecretExpiresAt !== null && auth.clientSecretExpiresAt <= Date.now())
            throw new CollectorError('Kiro device registration has expired. Run kiro-cli login.', 'auth-expired');
        let payload: unknown;
        try {
            payload = await context.requestJson(context.session, 'POST', kiroOidcEndpoint(auth.region), {'Content-Type': 'application/json'}, {
                clientId: auth.clientId,
                clientSecret: auth.clientSecret,
                grantType: 'refresh_token',
                refreshToken: auth.refreshToken,
            });
        } catch (error) {
            if (error instanceof CollectorError && ['offline', 'timeout', 'rate-limit'].includes(error.code)) throw error;
            throw new CollectorError('Kiro authentication could not be refreshed. Run kiro-cli login.', 'auth-expired');
        }
        const result = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
        const accessToken = text(result.accessToken);
        const expiresIn = typeof result.expiresIn === 'number' && Number.isFinite(result.expiresIn) ? result.expiresIn : null;
        if (!accessToken || expiresIn === null) throw new CollectorError('Kiro returned an invalid token refresh response. Run kiro-cli login.', 'auth-expired');
        auth = {...auth, accessToken, refreshToken: text(result.refreshToken) || auth.refreshToken, expiresAt: Date.now() + expiresIn * 1000};
        this.cachedAuth.set(instance.id, auth);
        return auth;
    }

    async collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled) return previous || emptySnapshot(instance.id);
        try {
            const auth = await this.auth(instance, context);
            const payload = await context.requestJson(context.session, 'POST', kiroUsageUrl({region: auth.serviceRegion, profileArn: auth.profileArn}), {
                Accept: 'application/json',
                Authorization: `Bearer ${auth.accessToken}`,
                'Content-Type': 'application/x-amz-json-1.0',
                'X-Amz-Target': 'AmazonCodeWhispererService.GetUsageLimits',
            }, {});
            const normalized = normalizeKiroUsage(payload);
            if (!normalized.windows.length) throw new CollectorError('The Kiro response did not contain recognized credit usage.', 'response-shape');
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
