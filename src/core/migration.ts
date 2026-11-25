import type Gio from 'gi://Gio';

import type {ServiceState} from './types.js';

// The 0.4 GSettings values that the service takes over once, under the names its ImportAccounts reads.
export interface LegacySettings {
    providerInstancesJson: string;
    configurationVersion: number;
    activeProviderId: string;
    refreshIntervalSeconds: number;
    notificationsEnabled: boolean;
    notificationStepPercent: number;
    diagnosticsJournal: boolean;
}

export type LegacySettingsSource = Pick<Gio.Settings, 'get_string' | 'get_uint' | 'get_boolean' | 'set_string'>;

export interface ImportingClient {
    readonly state: Pick<ServiceState, 'accounts'> | null;
    importAccounts(legacy: LegacySettings): Promise<number>;
}

const ACCOUNTS_KEY = 'provider-instances-json';
const NO_ACCOUNTS = '[]';

function legacySettings(settings: LegacySettingsSource): LegacySettings {
    return {
        providerInstancesJson: settings.get_string(ACCOUNTS_KEY),
        configurationVersion: settings.get_uint('configuration-version'),
        activeProviderId: settings.get_string('active-provider-id'),
        refreshIntervalSeconds: settings.get_uint('refresh-interval-seconds'),
        notificationsEnabled: settings.get_boolean('notifications-enabled'),
        notificationStepPercent: settings.get_uint('notification-step-percent'),
        diagnosticsJournal: settings.get_boolean('diagnostics-journal'),
    };
}

// 0.4 kept the accounts in GSettings. The service takes them only while it has none, and the key is
// emptied only after the service has them, so a failed import is tried again at the next connection.
export async function migrateOnce(settings: LegacySettingsSource, client: ImportingClient): Promise<void> {
    const state = client.state;
    if (state === null || state.accounts.length > 0)
        return;
    if (settings.get_string(ACCOUNTS_KEY).trim() === NO_ACCOUNTS)
        return;
    await client.importAccounts(legacySettings(settings));
    settings.set_string(ACCOUNTS_KEY, NO_ACCOUNTS);
}
