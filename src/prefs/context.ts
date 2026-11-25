import type Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ServiceCallError, type ClientHandlers, type ServiceClient} from '../client.js';
import {isCancellation} from '../core/gio.js';
import type {ProviderInstance, Settings} from '../core/types.js';

export type Change = 'status' | 'accounts' | 'settings';
export type PrefsLogger = Pick<Console, 'warn' | 'error'>;
// A call that the service refused or could not answer.
export type CallFailure = ServiceCallError | GLib.Error;

export interface Reply<T> {
    done?: (value: T) => void;
    failed?: (error: CallFailure) => void;
    // A narrower scope than the window, such as one rendering of a page.
    cancellable?: Gio.Cancellable;
}

// What the pages and dialogs of one Preferences window share: its service client, its
// cancellable and the changes that the service announces.
export class PrefsContext implements ClientHandlers {
    readonly client: ServiceClient;
    readonly cancellable = new Gio.Cancellable();
    private readonly _listeners = new Map<Change, Set<() => void>>();

    constructor(
        readonly window: Adw.PreferencesWindow,
        readonly extensionPath: string,
        readonly logger: PrefsLogger,
        createClient: (handlers: ClientHandlers) => ServiceClient
    ) {
        this.client = createClient(this);
    }

    get accounts(): ProviderInstance[] {
        return this.client.state?.accounts ?? [];
    }

    get settings(): Settings | null {
        return this.client.state?.settings ?? null;
    }

    // The returned function stops the listener.
    watch(change: Change, listener: () => void): () => void {
        const listeners = this._listeners.get(change) ?? new Set();
        listeners.add(listener);
        this._listeners.set(change, listeners);
        return () => listeners.delete(listener);
    }

    // The reply is dropped once the window or the given scope is gone. A refused call or a lost
    // connection is expected now and then, and the banner shows a lost service; anything else is a bug.
    request<T>(work: (client: ServiceClient) => Promise<T>, {done, failed, cancellable = this.cancellable}: Reply<T> = {}): void {
        if (this.client.status !== 'connected' || cancellable.is_cancelled())
            return;
        work(this.client).then(value => {
            if (this._stopped(cancellable))
                return;
            done?.(value);
        }, (error: unknown) => {
            if (this._stopped(cancellable) || isCancellation(error))
                return;
            if (!(error instanceof ServiceCallError || error instanceof GLib.Error)) {
                this.logger.error(error);
                return;
            }
            this.logger.warn(error);
            failed?.(error);
        });
    }

    destroy(): void {
        this.cancellable.cancel();
        this._listeners.clear();
    }

    onStatus(): void {
        this._emit('status');
        // Signals sent while the service was away are lost, so the pages start again from its state.
        if (this.client.status === 'connected') {
            this._emit('accounts');
            this._emit('settings');
        }
    }

    onAccountsChanged(): void {
        this._emit('accounts');
    }

    onSettingsChanged(): void {
        this._emit('settings');
    }

    onAccountChanged(): void {
        // Preferences show no readings.
    }

    onAlert(): void {
        // The Shell shows the alerts.
    }

    private _stopped(cancellable: Gio.Cancellable): boolean {
        return this.cancellable.is_cancelled() || cancellable.is_cancelled();
    }

    private _emit(change: Change): void {
        if (this.cancellable.is_cancelled())
            return;
        for (const listener of [...this._listeners.get(change) ?? []])
            listener();
    }
}
