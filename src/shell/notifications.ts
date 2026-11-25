import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import type {NotificationText} from '../core/notificationPolicy.js';
import type {ProviderInstance} from '../core/types.js';
import {providerGicon} from './accountChip.js';

// One message-tray source per account, so each alert carries the account's name and icon.
// The service decides when an alert is due, so nothing here keeps alert state.
export class Notifier {
    private readonly _extensionPath: string;
    private readonly _sources = new Map<string, MessageTray.Source>();

    constructor(extensionPath: string) {
        this._extensionPath = extensionPath;
    }

    notify(instance: Pick<ProviderInstance, 'id' | 'kind'>, text: NotificationText): void {
        const source = this._sourceFor(instance, text.source);
        source.addNotification(new MessageTray.Notification({source, title: text.title, body: text.body, isTransient: true}));
    }

    // The sources of removed accounts go with them.
    keepOnly(accountIds: readonly string[]): void {
        const kept = new Set(accountIds);
        for (const [id, source] of [...this._sources]) {
            if (!kept.has(id))
                source.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        }
    }

    destroy(): void {
        for (const source of [...this._sources.values()])
            source.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._sources.clear();
    }

    // The banner shows the source title as its header, so each alert retitles
    // the account's source. Alerts are transient, so no older entry keeps a stale header.
    private _sourceFor(instance: Pick<ProviderInstance, 'id' | 'kind'>, title: string): MessageTray.Source {
        const icon = providerGicon(this._extensionPath, instance.kind);
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
}
