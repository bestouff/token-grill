// @ts-nocheck
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {ProviderInstance, ProviderSnapshot} from '../core/types.js';
import {notificationBucket, selectedNotificationWindow, shouldNotifyMilestone} from '../core/notificationPolicy.js';
import {statePath, readJsonSync, writeJsonAtomic} from '../storage/atomicJson.js';

export class NotificationStore {
    private readonly stateFile = statePath('notifications-v1.json');
    private readonly state;
    private writeChain = Promise.resolve();

    constructor() {
        const loaded = readJsonSync(this.stateFile, {schemaVersion: 2, windows: {}});
        this.state = loaded?.schemaVersion === 2 && loaded?.windows && typeof loaded.windows === 'object'
            ? loaded
            : {schemaVersion: 2, windows: {}};
    }

    private persist() {
        this.writeChain = this.writeChain.then(() => writeJsonAtomic(this.stateFile, this.state)).catch(() => {});
        return this.writeChain;
    }

    notifyMilestones(instance: ProviderInstance, snapshot: ProviderSnapshot, stepPercent = 10): void {
        if (snapshot.state === 'error' || snapshot.state === 'disabled') return;
        const step = Math.max(5, Math.min(50, Math.round(stepPercent / 5) * 5));
        const window = selectedNotificationWindow(instance, snapshot);
        if (!window || window.percent === null || window.percent === undefined) return;
        const value = Math.max(0, Math.min(1, window.percent));
        const bucket = notificationBucket(value, step);
        const identity = `${window.canonicalWindow || window.id || 'usage'}:${window.resetAt || 'unknown'}`;
        const key = `${instance.id}:selected-limit`;
        const previous = this.state.windows[key] || null;
        const notify = shouldNotifyMilestone(previous, identity, bucket, step);
        this.state.windows[key] = {
            providerId: instance.id,
            canonicalWindow: window.canonicalWindow,
            resetIdentity: identity,
            resetAt: window.resetAt,
            lastObservedPercent: value,
            lastNotifiedBucket: Math.max(bucket, previous?.resetIdentity === identity ? previous.lastNotifiedBucket || 0 : 0),
            configuredStep: step,
            updatedAt: Date.now(),
            resetNotified: previous?.resetIdentity === identity ? Boolean(previous.resetNotified) : false,
        };
        for (const oldKey of Object.keys(this.state.windows))
            if (oldKey !== key && this.state.windows[oldKey]?.providerId === instance.id) delete this.state.windows[oldKey];
        void this.persist();
        if (notify)
            Main.notify(`${instance.displayName} · ${window.label} usage`, `${Math.round(value * 100)}% consumed · crossed the ${bucket * step}% milestone.`);
    }

    removeProvider(providerId: string): void {
        let changed = false;
        for (const key of Object.keys(this.state.windows)) {
            if (this.state.windows[key]?.providerId !== providerId) continue;
            delete this.state.windows[key];
            changed = true;
        }
        if (changed) void this.persist();
    }

    flush() { return this.persist(); }
}
