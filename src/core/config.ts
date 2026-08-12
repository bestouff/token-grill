import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ACCENTS, type AccentColor, type ProviderInstance, type ProviderKind, type QuotaWindowPreference} from './types.js';
import {expandPath} from './paths.js';
import {providerMetadata} from './providerMetadata.js';

export const SCHEMA_ID = 'org.gnome.shell.extensions.tokengrill';

export function getSettings(): Gio.Settings {
    return new Gio.Settings({schema_id: SCHEMA_ID});
}

export function readProviders(settings: Gio.Settings): ProviderInstance[] {
    try {
        const parsed: unknown = JSON.parse(settings.get_string('provider-instances-json'));
        if (!Array.isArray(parsed))
            return [];
        const providers = parsed.flatMap(item => normalizeProvider(item));
        const requiresMigration = settings.get_uint('configuration-version') < 2 || parsed.some(item =>
            Boolean(item && typeof item === 'object' && (item as Record<string, unknown>).schemaVersion === 1));
        if (requiresMigration) {
            // Migrate only after every entry has been validated and normalized.
            // This keeps a malformed legacy value intact for recovery instead of
            // replacing it with a partial configuration.
            const validEntries = parsed.length === providers.length;
            if (validEntries) {
                settings.set_string('provider-instances-json', JSON.stringify(providers));
                settings.set_uint('configuration-version', 2);
            }
        }
        return providers;
    } catch {
        return [];
    }
}

export function writeProviders(settings: Gio.Settings, providers: ProviderInstance[]): void {
    settings.set_string('provider-instances-json', JSON.stringify(providers));
    settings.set_uint('configuration-version', 2);
}

export function newProvider(kind: ProviderKind, accountHome: string): ProviderInstance {
    const metadata = providerMetadata(kind);
    return {
        schemaVersion: 2,
        id: GLib.uuid_string_random(),
        kind,
        displayName: metadata.label,
        accent: metadata.defaultAccent,
        enabled: true,
        showInPanel: true,
        sortOrder: 0,
        accountHome,
        authFileOverride: null,
        sessionsDirectoryOverride: null,
        liveUsageEnabled: true,
        localHistoryEnabled: false,
        panelWindowPreference: metadata.defaultQuotaWindow,
    };
}

export function normalizeProvider(value: unknown): ProviderInstance[] {
    if (!value || typeof value !== 'object')
        return [];
    const item = value as Record<string, unknown>;
    if (![1, 2].includes(item.schemaVersion as number) || typeof item.id !== 'string' || typeof item.kind !== 'string' ||
        !['codex', 'claude', 'kiro'].includes(item.kind) || typeof item.accountHome !== 'string')
        return [];
    const kind = item.kind as ProviderKind;
    const metadata = providerMetadata(kind);
    const accent = typeof item.accent === 'string' && ACCENTS.includes(item.accent as AccentColor) ? item.accent as AccentColor : metadata.defaultAccent;
    let panelWindowPreference: QuotaWindowPreference = ['automatic', 'five-hour', 'weekly', 'monthly'].includes(item.panelWindowPreference as string)
        ? item.panelWindowPreference as QuotaWindowPreference : metadata.defaultQuotaWindow;
    if (metadata.quotaWindows.length === 1 && panelWindowPreference !== metadata.quotaWindows[0])
        panelWindowPreference = metadata.defaultQuotaWindow;
    try {
        expandPath(item.accountHome);
    } catch {
        return [];
    }
    return [{
        schemaVersion: 2,
        id: item.id,
        kind,
        displayName: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim() : metadata.label,
        accent,
        enabled: item.enabled !== false,
        showInPanel: item.showInPanel !== false,
        sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : 0,
        accountHome: item.accountHome,
        authFileOverride: typeof item.authFileOverride === 'string' && item.authFileOverride ? item.authFileOverride : null,
        sessionsDirectoryOverride: typeof item.sessionsDirectoryOverride === 'string' && item.sessionsDirectoryOverride ? item.sessionsDirectoryOverride : null,
        liveUsageEnabled: item.liveUsageEnabled !== false,
        localHistoryEnabled: metadata.localHistorySupported && item.localHistoryEnabled === true,
        panelWindowPreference,
    }];
}
