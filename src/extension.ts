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
import {collectorFor} from './providers/registry.js';
import {TokenGrillIndicator} from './shell/indicator.js';
import {NotificationStore} from './shell/notifications.js';
import {loadCatalog} from './pricing/catalog.js';
import {getJson, requestJson} from './providers/base.js';
import {quotaFingerprint, snapshotFingerprint} from './core/snapshotFingerprint.js';
import type {ProviderInstance, ProviderSnapshot, ProviderRefreshState, ProviderRuntimeState, RefreshPhase, RefreshRequestResult} from './core/types.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

class Runtime {
    readonly settings;
    readonly aggregates = new AggregateStore();
    readonly checkpoints = new CheckpointStore();
    readonly session = new Soup.Session({user_agent: 'TokenGrill/0.1', timeout: 30});
    readonly notifications = new NotificationStore();
    readonly catalog;
    readonly snapshots = new Map<string, ProviderSnapshot>();
    readonly runtimeStates = new Map<string, ProviderRuntimeState>();
    readonly scheduler: Scheduler;
    providers: ProviderInstance[] = [];
    indicator: TokenGrillIndicator | null = null;
    locked = false;
    paused = false;
    private settingsId = 0;
    private suppressProviderRefresh = false;

    constructor(readonly extension: Extension) {
        this.settings = extension.getSettings();
        this.catalog = loadCatalog(`${extension.path}/pricing-v1.json`);
        this.scheduler = new Scheduler(jobs => void this.collect(jobs), this.settings.get_uint('refresh-interval-seconds'));
    }

    start(): void {
        this.providers = readProviders(this.settings).sort((a, b) => a.sortOrder - b.sortOrder);
        this.ensureActiveProvider();
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
        this.settingsId = this.settings.connect('changed', (_settings, key) => {
            if (key === 'provider-instances-json' || key === 'configuration-version') this.reload(!this.suppressProviderRefresh);
            else if (key === 'refresh-interval-seconds') {
                this.scheduler.setInterval(this.settings.get_uint('refresh-interval-seconds')); this.renderIndicator();
            } else if (key === 'pause-when-session-locked') {
                this.setLocked(Main.sessionMode.isLocked); this.renderIndicator();
            } else this.renderIndicator();
        });
        this.scheduler.setProviders(this.providers);
        this.scheduler.start();
        this.refreshNow();
    }

    reload(collect = true): void {
        const next = readProviders(this.settings).sort((a, b) => a.sortOrder - b.sortOrder);
        const retained = new Set(next.map(provider => provider.id));
        for (const provider of this.providers) {
            if (retained.has(provider.id)) continue;
            this.aggregates.removeProvider(provider.id);
            this.checkpoints.removeProvider(provider.id);
            this.notifications.removeProvider(provider.id);
        }
        this.providers = next;
        this.ensureActiveProvider();
        this.scheduler.setInterval(this.settings.get_uint('refresh-interval-seconds'));
        this.scheduler.setProviders(this.providers);
        this.updateIndicator();
        if (collect) this.refreshNow();
    }

    async collect(jobs): Promise<void> {
        try {
            for (const job of jobs) {
                if (this.locked) break;
                const context = {
                    aggregates: this.aggregates,
                    checkpoints: this.checkpoints,
                    session: this.session,
                    catalog: this.catalog,
                    getJson,
                    requestJson,
                    onSourcePhase: source => {
                        this.setRefreshPhase(job.provider.id, source === 'reset-credits' ? 'fetching-reset-credits' : source === 'history' ? 'scanning-history' : 'fetching-limits');
                        this.renderIndicator();
                    },
                    onSourceResult: (source, result) => {
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
                    const snapshot = await collectorFor(job.provider.kind).collect(job.provider, context, previous);
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
                    if (this.settings.get_boolean('notifications-enabled')) {
                        try {
                            this.notifications.notifyMilestones(job.provider, stamped, this.settings.get_uint('notification-step-percent'));
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
                    logError(error, `Token Grill failed to refresh ${job.provider.displayName}`);
                    const state = this.runtimeStates.get(job.provider.id);
                    if (state) {
                        state.refresh.phase = 'failed';
                        state.refresh.outcome = 'failed';
                        state.refresh.completedAt = Date.now();
                    }
                }
                // Rendering is deliberately outside the collector boundary.
                // A Shell actor error can never be reported as a provider/API
                // failure, and the scheduler always reaches complete().
                if (collected) this.renderIndicator();
            }
        } finally {
            this.scheduler.complete();
        }
    }

    refreshNow(): RefreshRequestResult {
        this.scheduler.setProviders(this.providers);
        return this.scheduler.refreshNow();
    }

    refreshAll(): RefreshRequestResult {
        for (const provider of this.providers.filter(item => item.enabled)) this.setRefreshPhase(provider.id, 'queued');
        this.renderIndicator();
        return this.refreshNow();
    }

    selectQuotaWindow(providerId: string, window: 'five-hour' | 'weekly' | 'monthly'): void {
        const providers = this.providers.map(provider => provider.id === providerId ? {...provider, panelWindowPreference: window} : provider);
        if (!providers.some(provider => provider.id === providerId)) return;
        this.suppressProviderRefresh = true;
        writeProviders(this.settings, providers);
        this.suppressProviderRefresh = false;
        this.providers = providers;
        this.renderIndicator();
    }

    refreshProvider(providerId: string): RefreshRequestResult {
        if (!this.providers.some(provider => provider.id === providerId && provider.enabled)) return {jobIds: [], acceptedProviderIds: [], coalescedProviderIds: [], rejectedProviderIds: [providerId]};
        this.setRefreshPhase(providerId, 'queued');
        const result = this.scheduler.refreshOne(providerId);
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
        const shouldLock = value && this.settings.get_boolean('pause-when-session-locked');
        this.locked = shouldLock;
        this.scheduler.setLocked(shouldLock);
        if (!shouldLock) this.refreshNow();
    }

    togglePaused(): void {
        this.paused = !this.paused;
        this.scheduler.setPaused(this.paused);
        this.renderIndicator();
    }

    renderIndicator(): void {
        this.indicator?.update(this.providers, this.snapshots, {
            activeProviderId: this.settings.get_string('active-provider-id'),
            mode: this.settings.get_string('panel-percentage-mode') || 'remaining',
            style: this.settings.get_string('panel-display-style') || 'text',
            paused: this.paused,
            runtimeStates: this.runtimeStates,
        });
    }

    updateIndicator(): void { this.renderIndicator(); }

    selectProvider(id: string): void {
        if (!this.providers.some(provider => provider.id === id && provider.enabled)) return;
        this.settings.set_string('active-provider-id', id);
        this.updateIndicator();
    }

    ensureActiveProvider(): void {
        const current = activeProvider(this.providers, this.settings.get_string('active-provider-id'));
        if (current && current.id !== this.settings.get_string('active-provider-id')) this.settings.set_string('active-provider-id', current.id);
    }

    stop(): void {
        if (this.settingsId) this.settings.disconnect(this.settingsId);
        this.scheduler.destroy();
        this.session.abort();
        void this.notifications.flush();
        this.indicator?.destroy();
        this.indicator = null;
        this.snapshots.clear();
        this.runtimeStates.clear();
    }
}

export default class TokenGrillExtension extends Extension {
    private runtime: Runtime | null = null;
    private lockId = 0;

    enable(): void {
        this.runtime = new Runtime(this);
        this.runtime.start();
        this.lockId = Main.sessionMode.connect('updated', () => this.runtime?.setLocked(Main.sessionMode.isLocked));
        this.runtime.setLocked(Main.sessionMode.isLocked);
    }

    disable(): void {
        if (this.lockId) Main.sessionMode.disconnect(this.lockId);
        this.lockId = 0;
        this.runtime?.stop();
        this.runtime = null;
    }
}
