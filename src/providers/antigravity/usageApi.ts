import {CollectorError} from '../../core/errors.js';
import {emptySnapshot, type ProviderInstance, type ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext} from '../base.js';
import {isAntigravityTokenFresh, loadAntigravityAuth, type AntigravityAuth} from './auth.js';
import {
    GOOGLE_OAUTH_TOKEN_URL,
    LOAD_CODE_ASSIST_ENDPOINT,
    FETCH_AVAILABLE_MODELS_ENDPOINT,
} from './endpoints.js';
import {normalizeAntigravityUsage} from './normalize.js';
import {isCancellation} from '../../storage/atomicJson.js';

function text(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null;
}

export class AntigravityUsageCollector extends BaseCollector {
    private readonly cachedAuth = new Map<string, AntigravityAuth>();

    private async auth(instance: ProviderInstance, context: CollectorContext): Promise<AntigravityAuth> {
        const stored = await loadAntigravityAuth(instance);
        const cached = this.cachedAuth.get(instance.id);

        const cachedExpiresAt = cached?.expiresAt ?? null;
        const storedExpiresAt = stored.expiresAt ?? null;

        let auth = cached && cached.path === stored.path && cachedExpiresAt !== null && storedExpiresAt !== null && cachedExpiresAt >= storedExpiresAt
            ? cached
            : stored;

        if (isAntigravityTokenFresh(auth)) {
            return auth;
        }

        if (!auth.refreshToken || !auth.clientId || !auth.clientSecret) {
            throw new CollectorError('Antigravity authentication has expired. Please log in to Antigravity.', 'auth-expired');
        }

        let payload: unknown;
        try {
            payload = await context.requestJson(
                context.session,
                'POST',
                GOOGLE_OAUTH_TOKEN_URL,
                {'Content-Type': 'application/json'},
                {
                    client_id: auth.clientId,
                    client_secret: auth.clientSecret,
                    refresh_token: auth.refreshToken,
                    grant_type: 'refresh_token',
                }
            );
        } catch (error) {
            if (isCancellation(error)) throw error;
            if (error instanceof CollectorError && ['offline', 'timeout', 'rate-limit'].includes(error.code)) throw error;
            throw new CollectorError('Antigravity authentication could not be refreshed. Please log in to Antigravity.', 'auth-expired');
        }

        const result = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
        const accessToken = text(result.access_token);
        const expiresIn = typeof result.expires_in === 'number' && Number.isFinite(result.expires_in) ? result.expires_in : null;

        if (!accessToken || expiresIn === null) {
            throw new CollectorError('Google OAuth returned an invalid token refresh response.', 'auth-expired');
        }

        auth = {
            ...auth,
            accessToken,
            expiresAt: Date.now() + expiresIn * 1000,
        };
        this.cachedAuth.set(instance.id, auth);
        return auth;
    }

    async collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled) return previous || emptySnapshot(instance.id);

        try {
            const auth = await this.auth(instance, context);
            const headers = {
                Accept: 'application/json',
                Authorization: `Bearer ${auth.accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity',
            };

            let codeAssistPayload: unknown = null;
            let projectId = auth.projectId || 'aicode-consumers';

            // 1. Query loadCodeAssist for plan and project metadata
            try {
                codeAssistPayload = await context.requestJson(
                    context.session,
                    'POST',
                    LOAD_CODE_ASSIST_ENDPOINT,
                    headers,
                    {
                        metadata: {
                            ideType: 'ANTIGRAVITY',
                            platform: 'PLATFORM_UNSPECIFIED',
                            pluginType: 'GEMINI',
                        },
                    }
                );

                if (codeAssistPayload && typeof codeAssistPayload === 'object') {
                    const codeAssistObj = codeAssistPayload as Record<string, unknown>;
                    if (typeof codeAssistObj.cloudaicompanionProject === 'string' && codeAssistObj.cloudaicompanionProject.trim()) {
                        projectId = codeAssistObj.cloudaicompanionProject.trim();
                    }
                }
            } catch (error) {
                if (isCancellation(error)) throw error;
                // Non-fatal if loadCodeAssist fails, proceed with default project ID
            }

            // 2. Fetch available models and their quotaInfo
            let modelsPayload: unknown;
            try {
                modelsPayload = await context.requestJson(
                    context.session,
                    'POST',
                    FETCH_AVAILABLE_MODELS_ENDPOINT,
                    headers,
                    { project: projectId }
                );
            } catch (error) {
                if (isCancellation(error)) throw error;
                if (projectId !== 'aicode-consumers') {
                    modelsPayload = await context.requestJson(
                        context.session,
                        'POST',
                        FETCH_AVAILABLE_MODELS_ENDPOINT,
                        headers,
                        { project: 'aicode-consumers' }
                    );
                } else {
                    throw error;
                }
            }

            const normalized = normalizeAntigravityUsage(codeAssistPayload, modelsPayload);
            if (!normalized.windows.length) {
                throw new CollectorError('The Antigravity response did not contain recognized model quota usage.', 'response-shape');
            }

            const now = Date.now();
            return {
                ...(previous || emptySnapshot(instance.id)),
                providerId: instance.id,
                state: 'ready',
                lastUpdated: now,
                quotaFetchedAt: now,
                error: null,
                errorInfo: null,
                plan: normalized.plan,
                windows: normalized.windows,
            };
        } catch (error) {
            return this.failed(instance, previous, error);
        }
    }

    destroy(): void {
        this.cachedAuth.clear();
    }
}
