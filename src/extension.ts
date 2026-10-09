// @ts-nocheck
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {readProviders, writeProviders} from './core/config.js';
import {activeProvider} from './core/display.js';
import {Scheduler} from './core/scheduler.js';
import {AggregateStore} from './storage/aggregateStore.js';
import {CheckpointStore} from './storage/checkpointStore.js';
import {CollectorRegistry} from './providers/registry.js';
import {TokenGrillIndicator} from './shell/indicator.js';
import {NotificationStore} from './shell/notifications.js';
import {loadCatalog, type PricingCatalog} from './pricing/catalog.js';
import {getJson, requestJson} from './providers/base.js';
import {isCancellation} from './storage/atomicJson.js';
import {quotaFingerprint, snapshotFingerprint} from './core/snapshotFingerprint.js';
import {parseTestNotificationRequest} from './core/notificationPolicy.js';
import type {ProviderInstance, ProviderSnapshot, ProviderRuntimeState, RefreshPhase, RefreshRequestResult} from './core/types.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

function rejected(providerIds: string[] = []): RefreshRequestResult {
    return {jobIds: [], acceptedProviderIds: [], coalescedProviderIds: [], rejectedProviderIds: providerIds};
}

class Runtime {
    settings: Gio.Settings | null;
    aggregates: AggregateStore | null = new AggregateStore();
    checkpoints: CheckpointStore | null = new CheckpointStore();
    session: Soup.Session | null = new Soup.Session({timeout: 30});
    notifications: NotificationStore | null;
    catalog: PricingCatalog = {};
    readonly snapshots = new Map<string, ProviderSnapshot>();
    readonly runtimeStates = new Map<string, ProviderRuntimeState>();
    scheduler: Scheduler | null;
    collectors: CollectorRegistry | null = new CollectorRegistry();
    cancellable: Gio.Cancellable | null = new Gio.Cancellable();
    providers: ProviderInstance[] = [];
    indicator: TokenGrillIndicator | null = null;
    locked = false;
    paused = false;
    private settingsId = 0;
    private suppressProviderRefresh = false;
    private lastTestNonce = '';

    constructor(readonly extension: Extension) {
        this.settings = extension.getSettings();
        this.notifications = new NotificationStore(extension.path);
        this.scheduler = new Scheduler(jobs => void this.collect(jobs), this.settings.get_uint('refresh-interval-seconds'));
    }

    private isActive(cancellable: Gio.Cancellable): boolean {
        return this.cancellable === cancellable && !cancellable.is_cancelled();
    }

    async start(): Promise<void> {
        const cancellable = this.cancellable;
        const aggregates = this.aggregates;
        const checkpoints = this.checkpoints;
        const notifications = this.notifications;
        const settings = this.settings;
        const scheduler = this.scheduler;
        if (!cancellable || !aggregates || !checkpoints || !notifications || !settings || !scheduler) return;

        const [, , , catalog] = await Promise.all([
            aggregates.initialize(cancellable),
            checkpoints.initialize(cancellable),
            notifications.initialize(cancellable),
            loadCatalog(`${this.extension.path}/pricing-v1.json`, cancellable),
        ]);
        if (!this.isActive(cancellable)) return;

        this.catalog = catalog;
        this.providers = readProviders(settings).sort((a, b) => a.sortOrder - b.sortOrder);
        this.ensureActiveProvider();
        if (!this.isActive(cancellable)) return;
        this.indicator = new TokenGrillIndicator(this.extension, {
            refreshAll: () => this.refreshAll(),
            refreshProvider: provider => this.refreshProvider(provider.id),
            selectProvider: id => this.selectProvider(id),
            openPreferences: () => this.extension.openPreferences(),
            togglePaused: () => this.togglePaused(),
            selectQuotaWindow: (providerId, window) => this.selectQuotaWindow(providerId, window),
        });
        Main.panel.addToStatusArea('tokengrill', this.indicator, 1, 'right');
        this.updateIndicator();
        this.settingsId = settings.connect('changed', (_settings, key) => {
            if (!this.isActive(cancellable)) return;
            if (key === 'provider-instances-json' || key === 'configuration-version') this.reload(!this.suppressProviderRefresh);
            else if (key === 'notification-test-request') this.sendTestNotification(settings.get_string(key));
            else if (key === 'refresh-interval-seconds') {
                scheduler.setInterval(settings.get_uint('refresh-interval-seconds'));
                this.renderIndicator();
            } else if (key === 'pause-when-session-locked') {
                this.setLocked(Main.sessionMode.isLocked);
                this.renderIndicator();
            } else this.renderIndicator();
        });
        scheduler.setProviders(this.providers);
        scheduler.start();
        this.refreshNow();
    }

    reload(collect = true): void {
        const settings = this.settings;
        const scheduler = this.scheduler;
        const aggregates = this.aggregates;
        const checkpoints = this.checkpoints;
        const notifications = this.notifications;
        if (!settings || !scheduler || !aggregates || !checkpoints || !notifications) return;
        const next = readProviders(settings).sort((a, b) => a.sortOrder - b.sortOrder);
        const retained = new Set(next.map(provider => provider.id));
        for (const provider of this.providers) {
            if (retained.has(provider.id)) continue;
            aggregates.removeProvider(provider.id);
            checkpoints.removeProvider(provider.id);
            notifications.removeProvider(provider.id);
        }
        this.providers = next;
        this.ensureActiveProvider();
        scheduler.setInterval(settings.get_uint('refresh-interval-seconds'));
        scheduler.setProviders(this.providers);
        this.updateIndicator();
        if (collect) this.refreshNow();
    }

    sendTestNotification(value: string): void {
        const request = parseTestNotificationRequest(value);
        const settings = this.settings;
        const notifications = this.notifications;
        if (!request || request.nonce === this.lastTestNonce || !settings || !notifications) return;
        const provider = this.providers.find(item => item.id === request.providerId);
        if (!provider) return;
        this.lastTestNonce = request.nonce;
        const percentageMode = settings.get_string('panel-percentage-mode') === 'used' ? 'used' : 'remaining';
        notifications.notifyTest(provider, this.snapshots.get(provider.id) || null, percentageMode);
    }

    async collect(jobs): Promise<void> {
        const cancellable = this.cancellable;
        const aggregates = this.aggregates;
        const checkpoints = this.checkpoints;
        const session = this.session;
        const collectors = this.collectors;
        const scheduler = this.scheduler;
        if (!cancellable || !aggregates || !checkpoints || !session || !collectors || !scheduler) return;
        try {
            for (const job of jobs) {
                if (this.locked || !this.isActive(cancellable)) break;
                const context = {
                    aggregates,
                    checkpoints,
                    session,
                    catalog: this.catalog,
                    cancellable,
                    getJson: (requestSession, url, headers) => getJson(requestSession, url, headers, cancellable),
                    requestJson: (requestSession, method, url, headers, body) => requestJson(requestSession, method, url, headers, body, cancellable),
                    onSourcePhase: source => {
                        if (!this.isActive(cancellable)) return;
                        this.setRefreshPhase(job.provider.id, source === 'reset-credits' ? 'fetching-reset-credits' : source === 'history' ? 'scanning-history' : 'fetching-limits');
                        this.renderIndicator();
                    },
                    onSourceResult: (source, result) => {
                        if (!this.isActive(cancellable)) return;
                        const state = this.runtimeStates.get(job.provider.id) || this.newRuntimeState(job.provider.id);
                        const target = source === 'limits' ? state.refresh.limits : source === 'reset-credits' ? state.refresh.resetCredits : state.refresh.localHistory;
                        target.phase = result === 'success' ? 'success' : 'failed';
                        target.completedAt = Date.now();
                        this.runtimeStates.set(job.provider.id, state);
                    },
                };
                this.setRefreshPhase(job.provider.id, 'fetching-limits');
                let collected = false;
                try {
                    const previous = this.snapshots.get(job.provider.id) || null;
                    const snapshot = await collectors.get(job.provider.kind).collect(job.provider, context, previous);
                    if (!this.isActive(cancellable)) break;
                    const changed = snapshotFingerprint(previous) !== snapshotFingerprint(snapshot);
                    const quotaChanged = quotaFingerprint(previous) !== quotaFingerprint(snapshot);
                    const fetchedAt = snapshot.quotaFetchedAt || null;
                    const stamped = {
                        ...snapshot,
                        quotaDataChangedAt: quotaChanged ? (fetchedAt || Date.now()) : (previous?.quotaDataChangedAt || null),
                    };
                    this.snapshots.set(job.provider.id, stamped);
                    const runtimeState = this.runtimeStates.get(job.provider.id) || this.newRuntimeState(job.provider.id);
                    runtimeState.snapshot = stamped;
                    this.runtimeStates.set(job.provider.id, runtimeState);
                    collected = true;
                    const settings = this.settings;
                    const notifications = this.notifications;
                    if (settings && notifications && settings.get_boolean('notifications-enabled') && this.isActive(cancellable)) {
                        try {
                            const percentageMode = settings.get_string('panel-percentage-mode') === 'used' ? 'used' : 'remaining';
                            notifications.notifyMilestones(job.provider, stamped, settings.get_uint('notification-step-percent'), percentageMode);
                        } catch (error) {
                            logError(error, `Token Grill notification failure for ${job.provider.displayName}`);
                        }
                    }
                    const state = this.runtimeStates.get(job.provider.id);
                    if (stamped.error) {
                        if (state) {
                            state.refresh.phase = 'failed';
                            state.refresh.outcome = 'failed';
                            state.refresh.completedAt = Date.now();
                            state.error = snapshot.errorInfo;
                        }
                    } else if (state) {
                        const sourceFailed = [state.refresh.limits, state.refresh.resetCredits, state.refresh.localHistory].some(source => source.enabled && source.phase === 'failed');
                        state.refresh.phase = sourceFailed ? 'partial' : 'success';
                        state.refresh.outcome = sourceFailed ? 'partial' : previous && !changed ? 'unchanged' : 'changed';
                        state.refresh.completedAt = Date.now();
                        state.refresh.lastSuccessfulRefresh = snapshot.quotaFetchedAt || Date.now();
                        if (state.refresh.outcome === 'changed') state.refresh.lastDataChangeAt = Date.now();
                        state.error = null;
                    }
                } catch (error) {
                    if (cancellable.is_cancelled() || isCancellation(error)) break;
                    logError(error, `Token Grill failed to refresh ${job.provider.displayName}`);
                    const state = this.runtimeStates.get(job.provider.id);
                    if (state) {
                        state.refresh.phase = 'failed';
                        state.refresh.outcome = 'failed';
                        state.refresh.completedAt = Date.now();
                    }
                }
                if (collected && this.isActive(cancellable)) this.renderIndicator();
            }
        } finally {
            if (this.scheduler === scheduler && this.isActive(cancellable)) scheduler.complete();
        }
    }

    refreshNow(): RefreshRequestResult {
        const scheduler = this.scheduler;
        if (!scheduler) return rejected(this.providers.filter(provider => provider.enabled).map(provider => provider.id));
        scheduler.setProviders(this.providers);
        return scheduler.refreshNow();
    }

    refreshAll(): RefreshRequestResult {
        for (const provider of this.providers.filter(item => item.enabled)) this.setRefreshPhase(provider.id, 'queued');
        this.renderIndicator();
        return this.refreshNow();
    }

    selectQuotaWindow(providerId: string, window: 'five-hour' | 'weekly' | 'monthly'): void {
        const settings = this.settings;
        if (!settings) return;
        const providers = this.providers.map(provider => provider.id === providerId ? {...provider, panelWindowPreference: window} : provider);
        if (!providers.some(provider => provider.id === providerId)) return;
        this.suppressProviderRefresh = true;
        writeProviders(settings, providers);
        this.suppressProviderRefresh = false;
        this.lastTestNonce = '';
        this.providers = providers;
        this.renderIndicator();
    }

    refreshProvider(providerId: string): RefreshRequestResult {
        const scheduler = this.scheduler;
        if (!scheduler || !this.providers.some(provider => provider.id === providerId && provider.enabled)) return rejected([providerId]);
        this.setRefreshPhase(providerId, 'queued');
        const result = scheduler.refreshOne(providerId);
        if (result.rejectedProviderIds.length) {
            const state = this.runtimeStates.get(providerId);
            if (state) {
                state.refresh.phase = 'failed';
                state.refresh.outcome = 'failed';
                state.refresh.completedAt = Date.now();
            }
        }
        this.renderIndicator();
        return result;
    }

    setRefreshPhase(providerId: string, phase: RefreshPhase): void {
        const state = this.runtimeStates.get(providerId) || this.newRuntimeState(providerId);
        const wasBusy = ['queued', 'fetching-limits', 'fetching-reset-credits', 'scanning-history'].includes(state.refresh.phase);
        state.refresh.phase = phase;
        if (phase === 'fetching-limits') {
            state.refresh.startedAt ??= Date.now();
            state.refresh.lastAttemptAt = Date.now();
        }
        if (phase === 'queued') {
            if (!wasBusy) state.refresh.jobId = `${providerId}-${Date.now()}`;
            state.refresh.requestedAt = Date.now();
            state.refresh.trigger = 'manual-provider';
            state.refresh.outcome = null;
            state.refresh.startedAt = null;
            state.refresh.completedAt = null;
            for (const source of [state.refresh.limits, state.refresh.resetCredits, state.refresh.localHistory]) {
                source.phase = 'idle';
                source.startedAt = null;
                source.completedAt = null;
                source.error = null;
            }
        }
        this.runtimeStates.set(providerId, state);
    }

    newRuntimeState(providerId: string): ProviderRuntimeState {
        const source = () => ({enabled: true, phase: 'idle' as const, startedAt: null, completedAt: null, error: null});
        return {
            providerId,
            snapshot: this.snapshots.get(providerId) || null,
            refresh: {jobId: null, providerId, trigger: null, phase: 'idle', requestedAt: null, startedAt: null, completedAt: null, lastAttemptAt: null, lastSuccessfulRefresh: null, lastDataChangeAt: null, outcome: null, limits: source(), resetCredits: source(), localHistory: source()},
            error: null,
        };
    }

    setLocked(value: boolean): void {
        const settings = this.settings;
        const scheduler = this.scheduler;
        if (!settings || !scheduler) return;
        const shouldLock = value && settings.get_boolean('pause-when-session-locked');
        this.locked = shouldLock;
        scheduler.setLocked(shouldLock);
        if (!shouldLock) this.refreshNow();
    }

    togglePaused(): void {
        const scheduler = this.scheduler;
        if (!scheduler) return;
        this.paused = !this.paused;
        scheduler.setPaused(this.paused);
        this.renderIndicator();
    }

    renderIndicator(): void {
        const settings = this.settings;
        if (!settings) return;
        this.indicator?.update(this.providers, this.snapshots, {
            activeProviderId: settings.get_string('active-provider-id'),
            mode: settings.get_string('panel-percentage-mode') || 'remaining',
            style: settings.get_string('panel-display-style') || 'text',
            showAllAccounts: settings.get_boolean('panel-show-all-accounts'),
            paused: this.paused,
            runtimeStates: this.runtimeStates,
        });
    }

    updateIndicator(): void { this.renderIndicator(); }

    selectProvider(id: string): void {
        const settings = this.settings;
        if (!settings || !this.providers.some(provider => provider.id === id && provider.enabled)) return;
        settings.set_string('active-provider-id', id);
        this.updateIndicator();
    }

    ensureActiveProvider(): void {
        const settings = this.settings;
        if (!settings) return;
        const activeId = settings.get_string('active-provider-id');
        const current = activeProvider(this.providers, activeId);
        if (current && current.id !== activeId) settings.set_string('active-provider-id', current.id);
    }

    stop(): void {
        const cancellable = this.cancellable;
        cancellable?.cancel();

        const settings = this.settings;
        if (settings && this.settingsId) settings.disconnect(this.settingsId);
        this.settingsId = 0;

        this.scheduler?.destroy();
        this.scheduler = null;

        this.session?.abort();
        this.session = null;

        const notifications = this.notifications;
        const pendingFlushes = [this.aggregates?.flush(), this.checkpoints?.flush(), notifications?.flush()]
            .filter(Boolean) as Promise<void>[];
        void Promise.allSettled(pendingFlushes);
        notifications?.destroy();

        this.indicator?.destroy();
        this.indicator = null;

        this.collectors?.destroy();
        this.collectors = null;

        this.snapshots.clear();
        this.runtimeStates.clear();
        this.providers = [];
        this.catalog = {};
        this.aggregates = null;
        this.checkpoints = null;
        this.notifications = null;
        this.settings = null;
        this.cancellable = null;
        this.suppressProviderRefresh = false;
    }
}

export default class TokenGrillExtension extends Extension {
    private runtime: Runtime | null = null;
    private lockId = 0;

    enable(): void {
        const runtime = new Runtime(this);
        this.runtime = runtime;
        void runtime.start().catch(error => {
            if (this.runtime !== runtime || isCancellation(error)) return;
            logError(error, 'Token Grill failed to start');
            runtime.stop();
            this.runtime = null;
        });
        this.lockId = Main.sessionMode.connect('updated', () => this.runtime?.setLocked(Main.sessionMode.isLocked));
        runtime.setLocked(Main.sessionMode.isLocked);
    }

    disable(): void {
        if (this.lockId) Main.sessionMode.disconnect(this.lockId);
        this.lockId = 0;
        this.runtime?.stop();
        this.runtime = null;
    }
}
