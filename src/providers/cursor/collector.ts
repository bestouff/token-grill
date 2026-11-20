import GLib from 'gi://GLib';

import {CollectorError, NO_USAGE} from '../../core/errors.js';
import {providerPaths} from '../../core/paths.js';
import {emptySnapshot, type ProviderInstance, type ProviderSnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext, type LimitsUpdate} from '../base.js';
import {cursorDatabaseStamp, isCursorTokenFresh, readCursorAgentAuth, readCursorAuth, type CursorAuth} from './auth.js';
import {normalizeCursorPlan, normalizeCursorUsage} from './normalize.js';

const DASHBOARD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService';

// The dashboard service speaks the Connect protocol, which takes JSON over POST.
function requestHeaders(accessToken: string): Record<string, string> {
    return {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json',
    };
}

export class CursorCollector extends BaseCollector {
    // Stored app sign-ins, re-read only when Cursor's database changes on disk.
    private readonly _stored = new Map<string, {stamp: string; auth: CursorAuth}>();
    // The plan rarely changes, so it is asked for again only for a new sign-in or billing cycle.
    private readonly _plans = new Map<string, {key: string; plan: string | null}>();
    // The account each configured account last read, so a switch never shows the previous numbers.
    private readonly _subjects = new Map<string, string | null>();

    async collect(instance: ProviderInstance, context: CollectorContext, snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled)
            return snapshot;
        let auth: CursorAuth;
        try {
            auth = await this._auth(instance, context);
        } catch (error) {
            return this.limitsFailed(context, snapshot, error);
        }
        const known = this._subjects.has(instance.id);
        const switched = known && this._subjects.get(instance.id) !== auth.subject;
        this._subjects.set(instance.id, auth.subject);
        const start = switched ? emptySnapshot(instance.id) : snapshot;
        return this.collectLimits(context, start, () => this._fetchLimits(instance, context, auth));
    }

    private _auth(instance: ProviderInstance, context: CollectorContext): Promise<CursorAuth> {
        const path = providerPaths(instance).authFile;
        if (instance.app === 'cursor-agent')
            return readCursorAgentAuth(path, context.cancellable);
        return this._storedAuth(path, context);
    }

    private async _storedAuth(path: string, context: CollectorContext): Promise<CursorAuth> {
        const stamp = await cursorDatabaseStamp(path, context.cancellable);
        const cached = this._stored.get(path);
        if (cached?.stamp === stamp)
            return cached.auth;
        const auth = await readCursorAuth(path, context.cancellable);
        this._stored.set(path, {stamp, auth});
        return auth;
    }

    private async _fetchLimits(instance: ProviderInstance, context: CollectorContext, auth: CursorAuth): Promise<LimitsUpdate> {
        if (!isCursorTokenFresh(auth))
            throw new CollectorError('auth-expired', ({_}) => _('The Cursor sign-in has expired.'));
        const headers = requestHeaders(auth.accessToken);
        const windows = normalizeCursorUsage(await context.requestJson('POST', `${DASHBOARD_URL}/GetCurrentPeriodUsage`, headers, {}));
        const [first] = windows;
        if (!first)
            throw new CollectorError('response-shape', NO_USAGE);
        const signIn = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, auth.accessToken, -1)!;
        const plan = await this._plan(instance, context, headers, `${signIn}|${first.resetAt}`);
        return {windows, plan, account: auth.email};
    }

    private async _plan(instance: ProviderInstance, context: CollectorContext, headers: Record<string, string>, key: string): Promise<string | null> {
        const cached = this._plans.get(instance.id);
        if (cached?.key === key && !context.manual)
            return cached.plan;
        const plan = normalizeCursorPlan(await context.requestJson('POST', `${DASHBOARD_URL}/GetPlanInfo`, headers, {}));
        this._plans.set(instance.id, {key, plan});
        return plan;
    }
}
