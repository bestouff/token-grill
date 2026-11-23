import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {normalizeAccent} from './accent.js';
import {expandPath} from './paths.js';
import {PROVIDER_METADATA, providerMetadata} from './providerMetadata.js';
import {orderedProviders} from './providerOrder.js';
import type {AccountApp, ProviderInstance, ProviderKind, QuotaWindowPreference, TopBarSelection} from './types.js';

// The settings layout version; the entries themselves keep format 2 so 0.3.x can still read them.
export const CONFIGURATION_VERSION = 3;
export const ENTRY_SCHEMA_VERSION = 2;
const MAX_LIMIT_KEY_LENGTH = 64;
const QUOTA_WINDOW_PREFERENCES: QuotaWindowPreference[] = ['automatic', 'five-hour', 'weekly', 'monthly'];

function parseStoredProviders(settings: Gio.Settings): unknown[] {
    try {
        const parsed: unknown = JSON.parse(settings.get_string('provider-instances-json'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function isLegacyEntry(item: unknown): boolean {
    return Boolean(item && typeof item === 'object' && (item as Record<string, unknown>).schemaVersion === 1);
}

export function readProviders(settings: Gio.Settings): ProviderInstance[] {
    return orderedProviders(parseStoredProviders(settings).flatMap(item => normalizeProvider(item)));
}

export function writeProviders(settings: Gio.Settings, providers: ProviderInstance[]): void {
    settings.set_string('provider-instances-json', JSON.stringify(providers));
    settings.set_uint('configuration-version', CONFIGURATION_VERSION);
}

// 0.3.x fields that only the upgrade reads: whether the account was a top-bar
// tab, and the limit it showed there.
function storedField(item: unknown, key: 'showInPanel' | 'panelWindowPreference'): unknown {
    return item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined;
}

function legacyWindow(item: unknown, kind: ProviderKind): QuotaWindowPreference {
    const metadata = providerMetadata(kind);
    const stored = QUOTA_WINDOW_PREFERENCES.find(window => window === storedField(item, 'panelWindowPreference'));
    if (!stored)
        return metadata.defaultQuotaWindow;
    // 0.3.x fell back to the most used limit when the service did not report the chosen one.
    if (stored !== 'automatic' && !metadata.quotaWindows.includes(stored))
        return metadata.quotaWindows.length === 1 ? metadata.defaultQuotaWindow : 'automatic';
    return stored;
}

// Before 0.4.0 the top bar showed one account, the active one, with its
// preferred limit; that account keeps that look and the others start hidden.
function legacyTopBar(provider: ProviderInstance, item: unknown, activeId: string | null): TopBarSelection {
    if (provider.id !== activeId)
        return {automatic: false, limits: []};
    const window = legacyWindow(item, provider.kind);
    return window === 'automatic' ? {automatic: true, limits: []} : {automatic: false, limits: [window]};
}

// The account 0.3.x showed in the top bar, chosen the way 0.3.x chose it.
function legacyActiveId(providers: ProviderInstance[], stored: unknown[], activeId: string): string | null {
    const enabled = providers.filter(provider => provider.enabled);
    const tab = providers.find((provider, index) => provider.enabled && storedField(stored[index], 'showInPanel') !== false);
    return (enabled.find(provider => provider.id === activeId) ?? tab ?? enabled[0])?.id ?? null;
}

// A malformed legacy value is left untouched so it can still be recovered by hand;
// migrating it would silently drop the entries that fail to normalize.
export function migrateProviderSettings(settings: Gio.Settings): void {
    const stored = parseStoredProviders(settings);
    const version = settings.get_uint('configuration-version');
    const outdated = version < CONFIGURATION_VERSION || stored.some(isLegacyEntry);
    if (!outdated)
        return;
    let providers = stored.flatMap(item => normalizeProvider(item));
    if (providers.length !== stored.length)
        return;
    if (version < CONFIGURATION_VERSION) {
        const activeId = legacyActiveId(providers, stored, settings.get_string('active-provider-id'));
        providers = providers.map((provider, index) => hasTopBar(stored[index])
            ? provider
            : {...provider, topBar: legacyTopBar(provider, stored[index], activeId)});
    }
    writeProviders(settings, providers);
}

const READ_FIELDS = ['kind', 'app', 'accountHome', 'authFileOverride', 'sessionsDirectoryOverride', 'liveUsageEnabled', 'localHistoryEnabled'] as const;

// Name, colour, top-bar and warning changes need no new reading; a new account,
// one turned back on, or a change to how it is read does.
export function needsRefresh(previous: ProviderInstance | undefined, next: ProviderInstance): boolean {
    if (!previous || (next.enabled && !previous.enabled))
        return true;
    return READ_FIELDS.some(field => previous[field] !== next[field]);
}

export function newProvider(kind: ProviderKind, app: AccountApp, accountHome: string): ProviderInstance {
    const metadata = providerMetadata(kind);
    return {
        schemaVersion: ENTRY_SCHEMA_VERSION,
        id: GLib.uuid_string_random(),
        kind,
        app,
        displayName: metadata.label,
        accent: metadata.defaultAccent,
        enabled: true,
        sortOrder: 0,
        accountHome,
        authFileOverride: null,
        sessionsDirectoryOverride: null,
        liveUsageEnabled: true,
        localHistoryEnabled: false,
        topBar: {automatic: true, limits: []},
        lowBalance: null,
        showPace: false,
    };
}

function isValidPath(value: string): boolean {
    try {
        expandPath(value);
        return true;
    } catch {
        return false;
    }
}

function optionalPath(value: unknown): string | null {
    return typeof value === 'string' && value && isValidPath(value) ? value : null;
}

function hasTopBar(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).topBar);
}

function normalizeTopBar(value: unknown): TopBarSelection {
    if (!value || typeof value !== 'object')
        return {automatic: false, limits: []};
    const item = value as Record<string, unknown>;
    const keys = Array.isArray(item.limits) ? item.limits : [];
    const limits = keys.filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= MAX_LIMIT_KEY_LENGTH);
    return {automatic: item.automatic === true, limits: [...new Set(limits)]};
}

function normalizeApp(value: unknown, supported: readonly [AccountApp, ...AccountApp[]]): AccountApp {
    return supported.find(app => app === value) ?? supported[0];
}

function isProviderKind(value: unknown): value is ProviderKind {
    return typeof value === 'string' && Object.hasOwn(PROVIDER_METADATA, value);
}

export function normalizeProvider(value: unknown): ProviderInstance[] {
    if (!value || typeof value !== 'object')
        return [];
    const item = value as Record<string, unknown>;
    if (item.schemaVersion !== 1 && item.schemaVersion !== ENTRY_SCHEMA_VERSION)
        return [];
    if (typeof item.id !== 'string' || !isProviderKind(item.kind))
        return [];
    if (typeof item.accountHome !== 'string')
        return [];

    const metadata = providerMetadata(item.kind);
    // Local history is read from the service's own app; other apps only lend their sign-in.
    const app = normalizeApp(item.app, metadata.apps);
    // Only a key pasted into the keyring has no home.
    if (!isValidPath(item.accountHome) && !(app === 'keyring' && item.accountHome === ''))
        return [];
    const displayName = typeof item.displayName === 'string' ? item.displayName.trim() : '';

    return [{
        schemaVersion: ENTRY_SCHEMA_VERSION,
        id: item.id,
        kind: item.kind,
        app,
        displayName: displayName || metadata.label,
        accent: normalizeAccent(item.accent, metadata.defaultAccent),
        enabled: item.enabled !== false,
        sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : 0,
        accountHome: item.accountHome,
        authFileOverride: optionalPath(item.authFileOverride),
        sessionsDirectoryOverride: optionalPath(item.sessionsDirectoryOverride),
        liveUsageEnabled: item.liveUsageEnabled !== false,
        localHistoryEnabled: metadata.localHistorySupported && app === metadata.apps[0] && item.localHistoryEnabled === true,
        topBar: normalizeTopBar(item.topBar),
        lowBalance: typeof item.lowBalance === 'number' && Number.isFinite(item.lowBalance) && item.lowBalance >= 0 ? item.lowBalance : null,
        showPace: item.showPace === true,
    }];
}
