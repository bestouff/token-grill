import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isCancellation} from './core/gio.js';
import {
    parseAccountChanged, parseAccounts, parseAlert, parseImportResult, parseResult, parseSettings, parseState,
    ServiceSchemaError, statusForError,
    type ClientStatus,
} from './core/serviceState.js';
import type {
    AccountDraft, Alert, Candidate, ImportResult, ProviderInstance, ProviderRuntimeState, ProviderSnapshot, ServiceState, Settings,
} from './core/types.js';
import {INTERFACE_NAME, INTERFACE_XML, MIN_API_VERSION, OBJECT_PATH, SERVICE_NAME} from './dbus/interface.js';

export type {ClientStatus};

const RETRY_SECONDS = 15;
// Each try starts the service again, so a service that keeps failing is tried less and less often.
const MAX_RETRY_SECONDS = 300;
// A Hello that meets the idle exit: the bus starts a new service as soon as the old one has gone.
const SHUTTING_DOWN_RETRY_SECONDS = 1;
// The service starts on the first call and answers Hello after it has read its files.
const CALL_TIMEOUT_MS = 30000;
// Storing a key can wait for the user to answer the keyring's unlock prompt, so it has no time limit.
const NO_TIMEOUT = GLib.MAXINT32;
const ERROR_PREFIX = `${SERVICE_NAME}.Error.`;

export type ClientKind = 'shell' | 'prefs';

export interface ClientHandlers {
    onStatus(status: ClientStatus): void;
    onAccountChanged(accountId: string, snapshot: ProviderSnapshot, runtime: ProviderRuntimeState): void;
    onAccountsChanged(accounts: ProviderInstance[]): void;
    onSettingsChanged(settings: Settings): void;
    onAlert(alert: Alert): void;
}

// A failure that the service reported: `code` is the error name without its prefix, for example
// InvalidArgs, ShuttingDown, NotSupported, KeyringUnavailable or Internal.
export class ServiceCallError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'ServiceCallError';
    }
}

function callError(error: unknown): unknown {
    if (!(error instanceof GLib.Error) || !Gio.DBusError.is_remote_error(error))
        return error;
    // The name is read first: stripping removes it from the message.
    const name = Gio.DBusError.get_remote_error(error) ?? '';
    const code = name.startsWith(ERROR_PREFIX) ? name.slice(ERROR_PREFIX.length) : name;
    Gio.DBusError.strip_remote_error(error);
    return new ServiceCallError(code, error.message);
}

function newProxy(info: Gio.DBusInterfaceInfo, cancellable: Gio.Cancellable): Promise<Gio.DBusProxy> {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, info, SERVICE_NAME, OBJECT_PATH, INTERFACE_NAME,
            cancellable, (_source, result) => {
                try {
                    resolve(Gio.DBusProxy.new_for_bus_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export class ServiceClient {
    status: ClientStatus = 'connecting';
    state: ServiceState | null = null;

    // The interface text is a constant, so it is parsed once and not at every retry.
    private readonly _info = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML).lookup_interface(INTERFACE_NAME)!;
    private _proxy: Gio.DBusProxy | null = null;
    private _signalId: number | null = null;
    private _ownerId: number | null = null;
    private _retryId: number | null = null;
    // The failed tries since the last connection.
    private _failures = 0;
    // The proxy that Hello was sent on; it is told Goodbye when it is dropped.
    private _greeted: Gio.DBusProxy | null = null;

    // The owner's one cancellable goes to every call; the owner cancels it before destroy().
    constructor(
        private readonly _kind: ClientKind,
        private readonly _handlers: ClientHandlers,
        private readonly _logger: Pick<Console, 'error'>,
        private readonly _cancellable: Gio.Cancellable
    ) {}

    // Reaches the service, starting it if needed. A failure of the connection or of the service's
    // answer is a status and the client tries again after 15 seconds, then less often, until it is
    // connected; a bug rejects.
    async connect(): Promise<void> {
        if (this._cancellable.is_cancelled())
            return;
        this._dropProxy();
        this._setStatus('connecting');
        try {
            const proxy = await newProxy(this._info, this._cancellable);
            if (this._cancellable.is_cancelled())
                return;
            this._proxy = proxy;
            // The service registers the sender when it receives Hello, whether or not the reply is accepted.
            this._greeted = proxy;
            const state = parseState(await this._invoke('Hello', new GLib.Variant('(s)', [this._kind])));
            if (this._cancellable.is_cancelled())
                return;
            if (state.apiVersion < MIN_API_VERSION) {
                this._fail('too-old');
                return;
            }
            this.state = state;
            this._signalId = proxy.connect('g-signal', (_proxy, _sender, name, parameters) => {
                try {
                    this._onSignal(name, parameters.deepUnpack<string[]>());
                } catch (error) {
                    // A payload that does not parse is a fault of the service; the last state stays.
                    if (!(error instanceof ServiceSchemaError))
                        throw error;
                    this._logger.error(`The service sent a malformed ${name} signal`, error);
                }
            });
            this._ownerId = proxy.connect('notify::g-name-owner', () => {
                if (proxy.get_name_owner() === null)
                    this._fail('not-responding');
            });
            this._failures = 0;
            this._setStatus('connected');
        } catch (error) {
            if (isCancellation(error) || this._cancellable.is_cancelled())
                return;
            // Only failures of the connection or of the service's answer are a status; the rest is a bug.
            if (!(error instanceof GLib.Error || error instanceof ServiceCallError || error instanceof ServiceSchemaError))
                throw error;
            if (error instanceof ServiceCallError && error.code === 'ShuttingDown' && this._failures === 0) {
                // Still connecting: the card would only flash.
                this._failures++;
                this._dropProxy();
                this._scheduleRetry(SHUTTING_DOWN_RETRY_SECONDS);
                return;
            }
            this._fail(statusForError(error));
        }
    }

    // Tries now instead of waiting for the next step.
    retry(): void {
        if (this.status === 'connected' || this.status === 'connecting')
            return;
        this._reconnect();
    }

    destroy(): void {
        if (this._retryId !== null) {
            GLib.Source.remove(this._retryId);
            this._retryId = null;
        }
        this._dropProxy();
        this.state = null;
    }

    async getState(): Promise<ServiceState> {
        return parseState(await this._invoke('GetState'));
    }

    async refresh(accountId: string): Promise<void> {
        await this._invoke('Refresh', new GLib.Variant('(s)', [accountId]));
    }

    async refreshAll(): Promise<void> {
        await this._invoke('RefreshAll');
    }

    // The service sends no signal for a pause, so the state follows the reply.
    async setPaused(paused: boolean): Promise<void> {
        await this._invoke('SetPaused', new GLib.Variant('(b)', [paused]));
        if (this.state !== null && !this._cancellable.is_cancelled())
            this.state.paused = paused;
    }

    async importAccounts(legacy: unknown): Promise<ImportResult> {
        return parseImportResult(await this._invoke('ImportAccounts', new GLib.Variant('(s)', [JSON.stringify(legacy)])));
    }

    // Either the new ids, or the validation errors of each entry that was refused. A draft with a pasted
    // key fails with KeyringUnavailable when the keyring does not store it, and then nothing is added.
    async addAccounts(accounts: AccountDraft[]): Promise<{ids: string[]; errors: Record<string, Record<string, string>>}> {
        const pasted = accounts.some(account => account.apiKey !== undefined);
        const result = await this._json('AddAccounts', accounts, pasted ? NO_TIMEOUT : CALL_TIMEOUT_MS);
        return {
            ids: (result['ids'] ?? []) as string[],
            errors: (result['errors'] ?? {}) as Record<string, Record<string, string>>,
        };
    }

    async updateAccount(account: unknown): Promise<Record<string, string>> {
        return (await this._json('UpdateAccount', account))['errors'] as Record<string, string>;
    }

    async removeAccount(id: string, removeKey: boolean): Promise<void> {
        await this._invoke('RemoveAccount', new GLib.Variant('(sb)', [id, removeKey]));
    }

    async reorderAccounts(ids: string[]): Promise<void> {
        await this._invoke('ReorderAccounts', new GLib.Variant('(as)', [ids]));
    }

    async validateAccount(draft: unknown): Promise<Record<string, string>> {
        return (await this._json('ValidateAccount', draft))['errors'] as Record<string, string>;
    }

    // An empty app means every app.
    async discover(app: string): Promise<Candidate[]> {
        return parseResult(await this._invoke('Discover', new GLib.Variant('(s)', [app])))['candidates'] as Candidate[];
    }

    async credentialState(accountId: string): Promise<string> {
        const text = await this._invoke('CredentialState', new GLib.Variant('(s)', [accountId]));
        return parseResult(text)['state'] as string;
    }

    async saveApiKey(accountId: string, key: string): Promise<void> {
        await this._invoke('SaveApiKey', new GLib.Variant('(ss)', [accountId, key]), NO_TIMEOUT);
    }

    async toggleLimit(accountId: string, limitKey: string): Promise<void> {
        await this._invoke('ToggleLimit', new GLib.Variant('(ss)', [accountId, limitKey]));
    }

    async setAutomatic(accountId: string, automatic: boolean): Promise<void> {
        await this._invoke('SetAutomatic', new GLib.Variant('(sb)', [accountId, automatic]));
    }

    async setSettings(settings: Partial<Settings>): Promise<void> {
        await this._invoke('SetSettings', new GLib.Variant('(s)', [JSON.stringify(settings)]));
    }

    async sendTestAlert(accountId: string): Promise<void> {
        await this._invoke('SendTestAlert', new GLib.Variant('(s)', [accountId]));
    }

    diagnosticsReport(): Promise<string> {
        return this._invoke('DiagnosticsReport');
    }

    private _json(method: string, payload: unknown, timeout = CALL_TIMEOUT_MS): Promise<Record<string, unknown>> {
        return this._invoke(method, new GLib.Variant('(s)', [JSON.stringify(payload)]), timeout).then(parseResult);
    }

    // The methods that return one string.
    private async _invoke(method: string, parameters: GLib.Variant | null = null, timeout = CALL_TIMEOUT_MS): Promise<string> {
        const reply = await this._call(method, parameters, timeout);
        return reply.deepUnpack<[string]>()[0] ?? '';
    }

    private async _call(method: string, parameters: GLib.Variant | null, timeout = CALL_TIMEOUT_MS): Promise<GLib.Variant> {
        const proxy = this._proxy;
        if (proxy === null)
            throw new Error('The service client is not connected');
        try {
            return await proxy.call(method, parameters, Gio.DBusCallFlags.NONE, timeout, this._cancellable);
        } catch (error) {
            throw callError(error);
        }
    }

    private _onSignal(name: string, args: string[]): void {
        if (this._cancellable.is_cancelled())
            return;
        const payload = args[args.length - 1] ?? '';
        switch (name) {
        case 'AccountChanged': {
            const accountId = args[0] ?? '';
            const {snapshot, runtime} = parseAccountChanged(payload);
            if (this.state !== null) {
                this.state.snapshots[accountId] = snapshot;
                this.state.runtime[accountId] = runtime;
            }
            this._handlers.onAccountChanged(accountId, snapshot, runtime);
            break;
        }
        case 'AccountsChanged': {
            const accounts = parseAccounts(payload);
            if (this.state !== null)
                this.state.accounts = accounts;
            this._handlers.onAccountsChanged(accounts);
            break;
        }
        case 'SettingsChanged': {
            const settings = parseSettings(payload);
            if (this.state !== null)
                this.state.settings = settings;
            this._handlers.onSettingsChanged(settings);
            break;
        }
        case 'Alert':
            this._handlers.onAlert(parseAlert(payload));
            break;
        }
    }

    private _setStatus(status: ClientStatus): void {
        this.status = status;
        this._handlers.onStatus(status);
    }

    private _fail(status: ClientStatus): void {
        this._dropProxy();
        this._setStatus(status);
        this._failures++;
        this._scheduleRetry(Math.min(RETRY_SECONDS * 2 ** (this._failures - 1), MAX_RETRY_SECONDS));
    }

    private _reconnect(): void {
        this._clearRetry();
        this.connect().catch((error: unknown) => this._logger.error('Connecting to the service failed', error));
    }

    private _scheduleRetry(seconds: number): void {
        this._clearRetry();
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._retryId = null;
            if (!this._cancellable.is_cancelled())
                this._reconnect();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _clearRetry(): void {
        if (this._retryId !== null) {
            GLib.Source.remove(this._retryId);
            this._retryId = null;
        }
    }

    private _dropProxy(): void {
        if (this._greeted !== null) {
            // Without a callback, so nothing can run after destroy(). A client that shares the Shell's
            // bus connection never has its name vanish, so the service learns of the departure here.
            this._greeted.call('Goodbye', null, Gio.DBusCallFlags.NO_AUTO_START, -1, null, null);
            this._greeted = null;
        }
        if (this._proxy !== null) {
            if (this._signalId !== null)
                this._proxy.disconnect(this._signalId);
            if (this._ownerId !== null)
                this._proxy.disconnect(this._ownerId);
        }
        this._signalId = null;
        this._ownerId = null;
        this._proxy = null;
    }
}
