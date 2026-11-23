import GLib from 'gi://GLib';

import type {ProviderInstance} from './types.js';

export interface SchedulerJob {
    provider: ProviderInstance;
    manual: boolean;
}

const WAKE_SECONDS = 15;

// Providers are spread over the interval on first sight so accounts sharing a
// service do not all hit it in the same second.
export class Scheduler {
    private _sourceId: number | null = null;
    private _running = false;
    private _paused = false;
    private _providers: ProviderInstance[] = [];
    private readonly _due = new Map<string, number>();
    private readonly _manual = new Set<string>();

    constructor(private readonly _callback: (jobs: SchedulerJob[]) => void, private _intervalSeconds: number) {}

    start(): void {
        if (this._sourceId !== null)
            GLib.Source.remove(this._sourceId);
        this._sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WAKE_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // The schema keeps the interval between 60 and 3600 seconds.
    setIntervalSeconds(seconds: number): void {
        this._intervalSeconds = seconds;
    }

    setProviders(providers: ProviderInstance[]): void {
        this._providers = providers;
        const now = Date.now();
        for (const provider of providers) {
            if (!this._due.has(provider.id))
                this._due.set(provider.id, now + Math.random() * this._intervalSeconds * 1000);
        }
    }

    get paused(): boolean {
        return this._paused;
    }

    setPaused(paused: boolean): void {
        this._paused = paused;
    }

    // Returns false while paused, when nothing is queued.
    refresh(providerIds: string[]): boolean {
        if (this._paused)
            return false;
        const now = Date.now();
        for (const id of providerIds) {
            this._manual.add(id);
            this._due.set(id, now);
        }
        this._tick();
        return true;
    }

    complete(): void {
        this._running = false;
        this._tick();
    }

    destroy(): void {
        if (this._sourceId !== null)
            GLib.Source.remove(this._sourceId);
        this._sourceId = null;
        this._due.clear();
        this._manual.clear();
        this._providers = [];
    }

    private _tick(): void {
        if (this._running || this._paused)
            return;
        const now = Date.now();
        const jobs: SchedulerJob[] = [];
        for (const provider of this._providers) {
            if (!provider.enabled || (this._due.get(provider.id) ?? Infinity) > now)
                continue;
            jobs.push({provider, manual: this._manual.delete(provider.id)});
            this._due.set(provider.id, now + this._intervalSeconds * 1000);
        }
        if (jobs.length === 0)
            return;
        this._running = true;
        this._callback(jobs);
    }
}
