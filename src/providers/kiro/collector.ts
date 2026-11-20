import GLib from 'gi://GLib';

import {CollectorError, isTransientError, NO_USAGE} from '../../core/errors.js';
import {isRecord, numberAt, stringAt} from '../../core/json.js';
import {providerPaths} from '../../core/paths.js';
import {emptySnapshot, type ProviderInstance, type ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext, type LimitsUpdate} from '../base.js';
import {kiroDatabaseStamp, readKiroAuth} from './auth.js';
import {isKiroRefreshable, isKiroTokenFresh, type KiroAuth} from './authRecords.js';
import {kiroOidcEndpoint, kiroUsageRequestBody, kiroUsageUrl} from './endpoints.js';
import {normalizeKiroUsage} from './normalize.js';
import {KiroRejectedTokens, kiroUsageError} from './usagePolicy.js';

function authExpired(): CollectorError {
    return new CollectorError('auth-expired', ({_}) => _('The kiro-cli sign-in has expired.'));
}

// Identifies the credentials kiro-cli currently stores. Other tools may
// rewrite them at any time, so every cache is tied to this value.
function storedFingerprint(path: string, auth: KiroAuth): string {
    const material = [path, auth.accessToken, auth.refreshToken ?? '', auth.profileArn ?? ''].join('\n');
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, material, -1)!;
}

export class KiroCollector extends BaseCollector {
    // Stored sign-ins, re-read only when the database changes on disk.
    private readonly _stored = new Map<string, {stamp: string; auth: KiroAuth; fingerprint: string}>();
    // Tokens refreshed here. kiro-cli's store is opened read-only, so a refreshed
    // token stays valid only while kiro-cli still holds the sign-in it came from.
    private readonly _refreshed = new Map<string, {fingerprint: string; auth: KiroAuth}>();
    private readonly _rejected = new KiroRejectedTokens();

    async collect(instance: ProviderInstance, context: CollectorContext, snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled)
            return snapshot;
        let stored: {auth: KiroAuth; fingerprint: string};
        try {
            stored = await this._storedAuth(instance, context);
        } catch (error) {
            return this.limitsFailed(context, snapshot, error);
        }
        const {auth, fingerprint} = stored;
        const known = context.manual ? null : this._rejected.get(instance.id, fingerprint);
        if (known)
            return this._rejectedSnapshot(instance, context, snapshot, known);
        this._rejected.forget(instance.id);
        try {
            return this.limitsReady(context, snapshot, await this._fetchLimits(instance, context, auth, fingerprint));
        } catch (error) {
            if (this._rejected.remember(instance.id, fingerprint, error))
                return this._rejectedSnapshot(instance, context, snapshot, error);
            return this.limitsFailed(context, snapshot, error);
        }
    }

    // An account without Kiro usage says nothing about the previous account, so
    // its numbers are cleared instead of being shown as stale data.
    private _rejectedSnapshot(instance: ProviderInstance, context: CollectorContext, snapshot: ProviderSnapshot, error: unknown): ProviderSnapshot {
        const unsupported = error instanceof CollectorError && error.code === 'unsupported-account';
        return this.limitsFailed(context, unsupported ? emptySnapshot(instance.id) : snapshot, error);
    }

    private async _storedAuth(instance: ProviderInstance, context: CollectorContext): Promise<{auth: KiroAuth; fingerprint: string}> {
        const path = providerPaths(instance).authFile;
        const stamp = await kiroDatabaseStamp(path, context.cancellable);
        const cached = this._stored.get(path);
        if (cached?.stamp === stamp)
            return cached;
        const auth = await readKiroAuth(path, context.cancellable);
        const entry = {stamp, auth, fingerprint: storedFingerprint(path, auth)};
        this._stored.set(path, entry);
        return entry;
    }

    private async _fetchLimits(instance: ProviderInstance, context: CollectorContext, stored: KiroAuth, fingerprint: string): Promise<LimitsUpdate> {
        const auth = await this._freshAuth(instance, context, stored, fingerprint);
        let payload: unknown;
        try {
            payload = await context.requestJson('POST', kiroUsageUrl(auth.serviceRegion), {
                'Accept': 'application/json',
                'Authorization': `Bearer ${auth.accessToken}`,
                'Content-Type': 'application/x-amz-json-1.0',
                'X-Amz-Target': 'AmazonCodeWhispererService.GetUsageLimits',
            }, kiroUsageRequestBody(auth.profileArn));
        } catch (error) {
            throw kiroUsageError(error);
        }
        const usage = normalizeKiroUsage(payload);
        if (!usage.windows.length)
            throw new CollectorError('response-shape', NO_USAGE);
        return usage;
    }

    private async _freshAuth(instance: ProviderInstance, context: CollectorContext, stored: KiroAuth, fingerprint: string): Promise<KiroAuth> {
        const refreshed = this._refreshed.get(instance.id);
        if (refreshed?.fingerprint === fingerprint && refreshed.auth.expiresAt >= stored.expiresAt && isKiroTokenFresh(refreshed.auth))
            return refreshed.auth;
        if (isKiroTokenFresh(stored))
            return stored;
        if (!isKiroRefreshable(stored))
            throw authExpired();
        let payload: unknown;
        try {
            payload = await context.requestJson('POST', kiroOidcEndpoint(stored.region), {'Content-Type': 'application/json'}, {
                clientId: stored.clientId,
                clientSecret: stored.clientSecret,
                grantType: 'refresh_token',
                refreshToken: stored.refreshToken,
            });
        } catch (error) {
            if (!(error instanceof CollectorError) || isTransientError(error))
                throw error;
            throw authExpired();
        }
        const accessToken = isRecord(payload) ? stringAt(payload, 'accessToken') : null;
        const expiresIn = isRecord(payload) ? numberAt(payload, 'expiresIn') : null;
        if (!isRecord(payload) || !accessToken || expiresIn === null)
            throw authExpired();
        const refreshToken = stringAt(payload, 'refreshToken') ?? stored.refreshToken;
        const auth = {...stored, accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000};
        this._refreshed.set(instance.id, {fingerprint, auth});
        return auth;
    }
}
