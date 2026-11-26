import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ServiceCallError, ServiceClient, type ClientStatus} from './client.js';
import {activeProvider} from './core/display.js';
import {isCancellation} from './core/gio.js';
import {migrateOnce} from './core/migration.js';
import {alertText} from './core/notificationPolicy.js';
import {signInCommand} from './core/signIn.js';
import {isShown} from './core/topBar.js';
import type {Alert, PanelDisplayStyle, PanelPercentageMode, ProviderInstance, ProviderKind} from './core/types.js';
import {TokenGrillIndicator, type IndicatorController} from './shell/indicator.js';
import {Notifier} from './shell/notifications.js';
import {openSignIn} from './shell/signIn.js';
import {TRANSLATOR} from './shell/translator.js';

// Constructed only from TokenGrillExtension.enable(); stop() releases everything it creates.
// The service reads the accounts and decides the alerts; the runtime shows what it sends.
export class Runtime implements IndicatorController {
    private readonly _extension: Extension;
    private _settings: Gio.Settings | null;
    // The one cancellable of this enable(): every service call and every reply check uses it.
    private _cancellable: Gio.Cancellable | null = new Gio.Cancellable();
    private _client: ServiceClient | null;
    private _notifier: Notifier | null;
    private _indicator: TokenGrillIndicator | null = null;
    private _settingsChangedId: number | null = null;
    private _migration: Promise<void> | null = null;

    constructor(extension: Extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._notifier = new Notifier(extension.path);
        this._client = new ServiceClient('shell', {
            onStatus: status => this._onStatus(status),
            onAccountChanged: () => this._render(),
            onAccountsChanged: accounts => this._onAccountsChanged(accounts),
            onSettingsChanged: () => this._render(),
            onAlert: alert => this._onAlert(alert),
        }, extension.getLogger(), this._cancellable!);
    }

    start(): void {
        this._placeIndicator();
        this._settingsChangedId = this._settings!.connect('changed', (_settings, key) => this._onSettingChanged(key));
        this._render();
        this._client!.connect().catch(error => this._extension.getLogger().error(error));
    }

    stop(): void {
        this._cancellable!.cancel();
        this._cancellable = null;

        // The calls in flight were cancelled above. Sends Goodbye: the Shell's bus connection stays
        // open, so the service learns of the departure here.
        this._client!.destroy();
        this._client = null;

        this._settings!.disconnect(this._settingsChangedId!);
        this._settingsChangedId = null;

        this._indicator!.destroy();
        this._indicator = null;

        this._notifier!.destroy();
        this._notifier = null;

        this._settings = null;
        this._migration = null;
    }

    refreshAll(): void {
        this._request(client => client.refreshAll());
    }

    refreshProvider(providerId: string): void {
        this._request(client => client.refresh(providerId));
    }

    selectProvider(providerId: string): void {
        if (!this._accounts().some(provider => provider.id === providerId && provider.enabled))
            return;
        this._settings!.set_string('active-provider-id', providerId);
    }

    // Opening the menu from a service's top-bar entry selects its first shown account.
    selectService(kind: ProviderKind): void {
        const accounts = this._accounts().filter(provider => provider.enabled && provider.kind === kind);
        const target = accounts.find(isShown) ?? accounts[0];
        if (target)
            this.selectProvider(target.id);
    }

    toggleLimit(providerId: string, key: string): void {
        this._request(client => client.toggleLimit(providerId, key));
    }

    setAutomatic(providerId: string, on: boolean): void {
        this._request(client => client.setAutomatic(providerId, on));
    }

    // The command comes from the extension's own table, never from the bus.
    signIn(providerId: string): void {
        const provider = this._accounts().find(account => account.id === providerId);
        const snapshot = this._client!.state?.snapshots[providerId];
        const command = provider && snapshot ? signInCommand(provider, snapshot.homeIsDefault) : null;
        if (command)
            openSignIn(command.argv);
    }

    openPreferences(): void {
        this._extension.openPreferences();
    }

    setPaused(paused: boolean): void {
        this._request(client => client.setPaused(paused));
    }

    // The client also tries again by itself; the button saves the wait after an install.
    checkService(): void {
        this._client!.retry();
    }

    private _onStatus(status: ClientStatus): void {
        if (status === 'connected') {
            this._ensureActiveProvider();
            this._migrate();
        }
        this._render();
    }

    private _onAccountsChanged(accounts: ProviderInstance[]): void {
        this._notifier!.keepOnly(accounts.map(account => account.id));
        this._ensureActiveProvider();
        this._render();
    }

    private _onAlert(alert: Alert): void {
        const state = this._client!.state;
        const instance = state?.accounts.find(account => account.id === alert.accountId);
        if (!state || !instance)
            return;
        const text = alertText(TRANSLATOR, alert, instance, state.snapshots[instance.id] ?? null, this._percentageMode(), Date.now());
        if (text)
            this._notifier!.notify(instance, text);
    }

    // One import at a time: a reconnection while the first call is in flight must not send a second one.
    private _migrate(): void {
        if (this._migration !== null)
            return;
        const cancellable = this._cancellable!;
        this._migration = migrateOnce(this._settings!, this._client!, cancellable)
            .catch(error => {
                if (!cancellable.is_cancelled() && !isCancellation(error))
                    this._logFailure(error);
            })
            .finally(() => {
                if (!cancellable.is_cancelled())
                    this._migration = null;
            });
    }

    // A popup action goes to the service; the reply arrives as signals. After disable() nothing
    // runs: the client's calls are cancelled with it.
    private _request(action: (client: ServiceClient) => Promise<unknown>): void {
        const client = this._client!;
        const cancellable = this._cancellable!;
        // A switch the user moved goes back to what the service last sent.
        if (client.status !== 'connected') {
            this._render();
            return;
        }
        action(client).then(() => {
            if (cancellable.is_cancelled())
                return;
            this._render();
        }, error => {
            if (cancellable.is_cancelled() || isCancellation(error))
                return;
            this._logFailure(error);
            this._render();
        });
    }

    // A refused call or a lost connection is expected now and then; anything else is a bug.
    private _logFailure(error: unknown): void {
        const logger = this._extension.getLogger();
        if (error instanceof ServiceCallError || error instanceof GLib.Error)
            logger.warn(error);
        else
            logger.error(error);
    }

    private _onSettingChanged(key: string): void {
        if (key === 'panel-position')
            this._placeIndicator();
        this._render();
    }

    // The panel has no public way to move a button between its boxes, so the
    // indicator is rebuilt in the chosen box; its state comes from the service.
    private _placeIndicator(): void {
        this._indicator?.destroy();
        const side = this._settings!.get_string('panel-position') === 'left' ? 'left' : 'right';
        this._indicator = new TokenGrillIndicator(this._extension.path, this);
        Main.panel.addToStatusArea(this._extension.uuid, this._indicator, 1, side);
    }

    private _accounts(): ProviderInstance[] {
        return this._client!.state?.accounts ?? [];
    }

    private _ensureActiveProvider(): void {
        const settings = this._settings!;
        const activeId = settings.get_string('active-provider-id');
        const current = activeProvider(this._accounts(), activeId);
        if (current && current.id !== activeId)
            settings.set_string('active-provider-id', current.id);
    }

    private _percentageMode(): PanelPercentageMode {
        return this._settings!.get_string('panel-percentage-mode') === 'used' ? 'used' : 'remaining';
    }

    private _displayStyle(): PanelDisplayStyle {
        const style = this._settings!.get_string('panel-display-style');
        return style === 'ring' || style === 'bar' ? style : 'text';
    }

    private _render(): void {
        const state = this._client!.state;
        this._indicator!.update({
            service: this._client!.status,
            providers: state?.accounts ?? [],
            snapshots: new Map(Object.entries(state?.snapshots ?? {})),
            runtimeStates: new Map(Object.entries(state?.runtime ?? {})),
            activeProviderId: this._settings!.get_string('active-provider-id'),
            mode: this._percentageMode(),
            style: this._displayStyle(),
            accountPicker: this._settings!.get_string('popup-account-picker') === 'dropdown' ? 'dropdown' : 'buttons',
            paused: state?.paused ?? false,
        });
    }
}
