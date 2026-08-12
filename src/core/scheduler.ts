import GLib from 'gi://GLib';
import type {ProviderInstance, RefreshRequestResult} from './types.js';
import {Lifecycle} from './lifecycle.js';

export interface SchedulerJob {
    provider: ProviderInstance;
    live: boolean;
    local: boolean;
}

export class Scheduler {
    private sourceId: number | null = null;
    private running = false;
    private locked = false;
    private paused = false;
    private readonly lifecycle = new Lifecycle();
    private readonly due = new Map<string, number>();

    constructor(private readonly callback: (jobs: SchedulerJob[]) => void, private intervalSeconds = 300) {}

    start(): void {
        this.stop();
        this.sourceId = this.lifecycle.addSource(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            if (!this.locked && !this.paused && !this.running)
                this.tick();
            return GLib.SOURCE_CONTINUE;
        }));
    }

    setInterval(seconds: number): void {
        this.intervalSeconds = Math.max(60, Math.min(seconds, 3600));
    }

    schedule(providers: ProviderInstance[], immediate = false): void {
        const now = Date.now();
        for (const provider of providers) {
            if (!this.due.has(provider.id) || immediate)
                this.due.set(provider.id, immediate ? now : now + Math.random() * this.intervalSeconds * 1000);
        }
    }

    tick(): void {
        if (this.running) return;
        const now = Date.now();
        const jobs: SchedulerJob[] = [];
        for (const provider of this.providers()) {
            if (!provider.enabled || (this.due.get(provider.id) ?? Infinity) > now)
                continue;
            jobs.push({provider, live: provider.liveUsageEnabled, local: provider.localHistoryEnabled});
            this.due.set(provider.id, now + this.intervalSeconds * 1000);
        }
        if (jobs.length > 0) {
            this.running = true;
            this.callback(jobs);
        }
    }

    private providersList: ProviderInstance[] = [];
    private providers(): ProviderInstance[] { return this.providersList; }
    setProviders(providers: ProviderInstance[]): void {
        this.providersList = providers;
        this.schedule(providers);
    }
    complete(): void { this.running = false; if (!this.locked && !this.paused) this.tick(); }
    setLocked(locked: boolean): void { this.locked = locked; }
    setPaused(paused: boolean): void { this.paused = paused; }
    refreshNow(): RefreshRequestResult {
        const eligible = this.providersList.filter(provider => provider.enabled);
        if (this.paused || this.locked)
            return {jobIds: [], acceptedProviderIds: [], coalescedProviderIds: [], rejectedProviderIds: eligible.map(provider => provider.id)};
        const coalesced = this.running ? eligible.map(provider => provider.id) : [];
        this.schedule(eligible, true);
        this.tick();
        return {jobIds: eligible.map(provider => `${provider.id}-${Date.now()}`), acceptedProviderIds: eligible.map(provider => provider.id), coalescedProviderIds: coalesced, rejectedProviderIds: []};
    }
    refreshOne(providerId: string): RefreshRequestResult {
        const provider = this.providersList.find(item => item.id === providerId);
        if (!provider || !provider.enabled || this.locked || this.paused)
            return {jobIds: [], acceptedProviderIds: [], coalescedProviderIds: [], rejectedProviderIds: [providerId]};
        const coalesced = this.running;
        this.schedule([provider], true);
        if (!this.running) this.tick();
        return {jobIds: [`${providerId}-${Date.now()}`], acceptedProviderIds: [providerId], coalescedProviderIds: coalesced ? [providerId] : [], rejectedProviderIds: []};
    }
    stop(): void { if (this.sourceId !== null) { this.lifecycle.removeSource(this.sourceId); this.sourceId = null; } }
    destroy(): void { this.stop(); this.lifecycle.dispose(); this.due.clear(); }
}
