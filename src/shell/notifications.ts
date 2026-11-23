import type Gio from 'gi://Gio';

import type {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {isRecord} from '../core/json.js';
import {
    balanceNotificationText,
    checkMilestone,
    limitNotificationText,
    migrateNotificationState,
    notificationKey,
    shouldNotifyLowBalance,
    testNotificationText,
} from '../core/notificationPolicy.js';
import type {NotificationText} from '../core/notificationPolicy.js';
import {providerMetadata} from '../core/providerMetadata.js';
import {isShown, limitKey, shownLimits} from '../core/topBar.js';
import {BALANCE_KEY, type PanelPercentageMode, type ProviderInstance, type ProviderSnapshot, type UsageWindow} from '../core/types.js';
import {readJson, SerialWriter, statePath} from '../storage/atomicJson.js';
import {providerGicon} from './accountChip.js';
import {TRANSLATOR} from './translator.js';

interface WindowState {
    providerId: string;
    resetIdentity: string;
    lastNotifiedBucket: number;
    configuredStep: number;
}

interface NotificationState {
    schemaVersion: 2;
    windows: Record<string, WindowState>;
    // Whether each account's balance was below its warning at the last reading.
    lowBalance: Record<string, boolean>;
}

function emptyState(): NotificationState {
    return {schemaVersion: 2, windows: {}, lowBalance: {}};
}

// One message-tray source per account, so each alert carries the account's name and icon.
export class NotificationStore {
    private readonly _extension: Extension;
    private readonly _writer = new SerialWriter(statePath('notifications-v1.json'));
    private readonly _sources = new Map<string, MessageTray.Source>();
    private _state = emptyState();

    constructor(extension: Extension) {
        this._extension = extension;
    }

    async initialize(cancellable: Gio.Cancellable): Promise<void> {
        const loaded = await readJson<Partial<NotificationState> | null>(this._writer.path, null, cancellable, this._extension.getLogger());
        if (loaded?.schemaVersion !== 2 || !isRecord(loaded.windows))
            return;
        const lowBalance = Object.fromEntries(Object.entries(isRecord(loaded.lowBalance) ? loaded.lowBalance : {})
            .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
        this._state = {schemaVersion: 2, windows: migrateNotificationState(loaded.windows as Record<string, WindowState>), lowBalance};
    }

    // Only the limits shown in the top bar alert, each with its own milestones.
    notifyMilestones(instance: ProviderInstance, snapshot: ProviderSnapshot, stepPercent: number, mode: PanelPercentageMode): void {
        if (snapshot.state === 'error' || snapshot.state === 'disabled' || !isShown(instance))
            return;
        const limits = shownLimits(instance, snapshot);
        for (const window of limits)
            this._notifyLimit(instance, window, stepPercent, mode);
        if (limits.some(window => limitKey(window) === BALANCE_KEY))
            this._notifyBalance(instance, snapshot);
    }

    notifyTest(instance: ProviderInstance, snapshot: ProviderSnapshot | null, mode: PanelPercentageMode): void {
        this._show(instance, testNotificationText(TRANSLATOR, providerMetadata(instance.kind).label, instance, snapshot, mode, Date.now()));
    }

    removeProvider(providerId: string): void {
        const keys = Object.entries(this._state.windows).filter(([, state]) => state.providerId === providerId).map(([key]) => key);
        for (const key of keys)
            delete this._state.windows[key];
        const hadBalance = providerId in this._state.lowBalance;
        delete this._state.lowBalance[providerId];
        if (keys.length || hadBalance)
            this._persist();
        this._sources.get(providerId)?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    }

    flush(): Promise<void> {
        return this._writer.flush(() => this._state);
    }

    destroy(): void {
        for (const source of [...this._sources.values()])
            source.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._sources.clear();
    }

    private _notifyLimit(instance: ProviderInstance, window: UsageWindow, stepPercent: number, mode: PanelPercentageMode): void {
        if (window.percent === null)
            return;
        const key = notificationKey(instance.id, window);
        const previous = this._state.windows[key] ?? null;
        const {notify, consumed, checkpoint} = checkMilestone(previous, {...window, percent: window.percent}, stepPercent);
        const next: WindowState = {providerId: instance.id, ...checkpoint};
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
            this._state.windows[key] = next;
            this._persist();
        }
        if (notify)
            this._show(instance, limitNotificationText(TRANSLATOR, providerMetadata(instance.kind).label, instance, window, consumed, mode, Date.now()));
    }

    private _notifyBalance(instance: ProviderInstance, snapshot: ProviderSnapshot): void {
        if (!snapshot.balance || instance.lowBalance === null)
            return;
        const low = snapshot.balance.amount < instance.lowBalance;
        const previous = this._state.lowBalance[instance.id] ?? null;
        if (previous !== low) {
            this._state.lowBalance[instance.id] = low;
            this._persist();
        }
        if (shouldNotifyLowBalance(previous, low))
            this._show(instance, balanceNotificationText(TRANSLATOR, providerMetadata(instance.kind).label, instance, snapshot.balance));
    }

    private _persist(): void {
        this._writer.markDirty();
        this.flush().catch(error => this._extension.getLogger().warn(error));
    }

    // The banner shows the source title as its header, so each alert retitles
    // the account's source. Alerts are transient, so no older entry keeps a stale header.
    private _sourceFor(instance: ProviderInstance, title: string): MessageTray.Source {
        const icon = providerGicon(this._extension.path, instance.kind);
        const existing = this._sources.get(instance.id);
        if (existing) {
            existing.title = title;
            existing.icon = icon;
            return existing;
        }
        const source = new MessageTray.Source({title, icon});
        source.connect('destroy', () => this._sources.delete(instance.id));
        this._sources.set(instance.id, source);
        Main.messageTray.add(source);
        return source;
    }

    private _show(instance: ProviderInstance, text: NotificationText): void {
        const source = this._sourceFor(instance, text.source);
        source.addNotification(new MessageTray.Notification({source, title: text.title, body: text.body, isTransient: true}));
    }
}
