// @ts-nocheck
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import type {PanelPercentageMode, ProviderInstance, ProviderSnapshot} from '../core/types.js';
import {accentColor} from '../core/accent.js';
import {providerIconFile} from '../core/providerMetadata.js';
import {schemeAppearance} from './accountChip.js';
import {milestoneNotificationText, notificationBucket, selectedNotificationWindow, shouldNotifyMilestone, testNotificationText, testNotificationWindowLabel} from '../core/notificationPolicy.js';
import {statePath, readJson, writeJsonAtomic} from '../storage/atomicJson.js';

function providerNotificationIcon(instance: ProviderInstance, extensionPath: string): Gio.Icon {
    const appearance = schemeAppearance();
    const baseIcon = Gio.icon_new_for_string(`${extensionPath}/icons/providers/${providerIconFile(instance.kind, appearance)}`);
    const dotSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${accentColor(instance)}"/></svg>`;
    const dotIcon = new Gio.BytesIcon({bytes: new GLib.Bytes(new TextEncoder().encode(dotSvg))});
    const emblem = new Gio.Emblem({icon: dotIcon});
    return Gio.EmblemedIcon.new(baseIcon, emblem);
}

export class NotificationStore {
    private readonly stateFile = statePath('notifications-v1.json');
    private readonly sources = new Map();
    private state = {schemaVersion: 2, windows: {}};
    private writeChain = Promise.resolve();

    constructor(private readonly extensionPath: string) {}

    async initialize(cancellable: Gio.Cancellable | null = null): Promise<void> {
        const loaded = await readJson(this.stateFile, {schemaVersion: 2, windows: {}}, cancellable);
        this.state = loaded?.schemaVersion === 2 && loaded?.windows && typeof loaded.windows === 'object'
            ? loaded
            : {schemaVersion: 2, windows: {}};
    }

    private persist() {
        const snapshot = JSON.parse(JSON.stringify(this.state));
        this.writeChain = this.writeChain.then(() => writeJsonAtomic(this.stateFile, snapshot)).catch(() => {});
        return this.writeChain;
    }

    private sourceFor(instance: ProviderInstance) {
        let record = this.sources.get(instance.id);
        if (record) {
            record.source.title = `${instance.displayName} — Token Grill`;
            record.source.icon = providerNotificationIcon(instance, this.extensionPath);
            return record.source;
        }

        const source = new MessageTray.Source({
            title: `${instance.displayName} — Token Grill`,
            icon: providerNotificationIcon(instance, this.extensionPath),
        });
        record = {source, destroySignalId: 0};
        record.destroySignalId = source.connect('destroy', () => {
            const current = this.sources.get(instance.id);
            if (current?.source === source) this.sources.delete(instance.id);
            record.destroySignalId = 0;
        });
        this.sources.set(instance.id, record);
        Main.messageTray.add(source);
        return source;
    }

    private destroySource(providerId: string): void {
        const record = this.sources.get(providerId);
        if (!record) return;
        this.sources.delete(providerId);
        if (record.destroySignalId) record.source.disconnect(record.destroySignalId);
        record.destroySignalId = 0;
        record.source.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        record.source = null;
    }

    notifyMilestones(instance: ProviderInstance, snapshot: ProviderSnapshot, stepPercent = 10, percentageMode: PanelPercentageMode = 'remaining'): void {
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
        if (!notify) return;

        const source = this.sourceFor(instance);
        const text = milestoneNotificationText(window, value, bucket * step, percentageMode);
        source.addNotification(new MessageTray.Notification({
            source,
            title: text.title,
            body: text.body,
            isTransient: true,
        }));
    }

    notifyTest(instance: ProviderInstance, snapshot: ProviderSnapshot | null, percentageMode: PanelPercentageMode = 'remaining'): void {
        const source = this.sourceFor(instance);
        const text = testNotificationText(testNotificationWindowLabel(instance, snapshot), percentageMode);
        source.addNotification(new MessageTray.Notification({source, title: text.title, body: text.body, isTransient: true}));
    }

    removeProvider(providerId: string): void {
        let changed = false;
        for (const key of Object.keys(this.state.windows)) {
            if (this.state.windows[key]?.providerId !== providerId) continue;
            delete this.state.windows[key];
            changed = true;
        }
        if (changed) void this.persist();
        this.destroySource(providerId);
    }

    flush() { return this.persist(); }

    destroy(): void {
        for (const providerId of [...this.sources.keys()]) this.destroySource(providerId);
        this.sources.clear();
    }
}
