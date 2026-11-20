import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {ProviderInstance, ProviderKind, ProviderPaths} from './types.js';

const DEFAULT_HOMES: Record<ProviderKind, string[]> = {
    codex: ['.codex'],
    claude: ['.claude'],
    kiro: [],
    antigravity: ['.gemini', 'antigravity-cli'],
    'copilot': ['.config', 'gh'],
    'opencode-go': [],
    'deepseek': ['.claude'],
    'kimi': ['.kimi-code'],
    'cursor': [],
};

// Antigravity tools have written their OAuth credentials under each of these names.
const ANTIGRAVITY_AUTH_FILES = ['acp_token.json', 'oauth_creds.json', 'credentials.json'];

const AUTH_FILES: Record<ProviderKind, string> = {
    codex: 'auth.json',
    claude: '.credentials.json',
    kiro: 'data.sqlite3',
    antigravity: 'acp_token.json',
    'copilot': 'hosts.yml',
    'opencode-go': 'auth.json',
    'deepseek': 'settings.json',
    'kimi': 'credentials/kimi-code.json',
    'cursor': 'User/globalStorage/state.vscdb',
};

const HISTORY_DIRECTORIES: Record<ProviderKind, string[]> = {
    codex: ['sessions', 'archived_sessions'],
    claude: ['projects'],
    kiro: [],
    antigravity: [],
    'copilot': [],
    'opencode-go': [],
    'deepseek': [],
    'kimi': [],
    'cursor': [],
};

export function expandPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed)
        throw new Error('A path is required.');
    if (trimmed.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), trimmed.slice(2)]);
    if (!trimmed.startsWith('/'))
        throw new Error('Paths must be absolute or start with ~/.');
    return GLib.canonicalize_filename(trimmed, null);
}

export function displayPath(value: string): string {
    const home = GLib.get_home_dir();
    if (value === home)
        return '~';
    if (value.startsWith(`${home}/`))
        return `~/${value.slice(home.length + 1)}`;
    return value;
}

export function defaultHome(kind: ProviderKind): string {
    if (kind === 'kiro')
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'kiro-cli']);
    if (kind === 'opencode-go')
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode']);
    if (kind === 'cursor')
        return GLib.build_filenamev([GLib.get_user_config_dir(), 'Cursor']);
    return GLib.build_filenamev([GLib.get_home_dir(), ...DEFAULT_HOMES[kind]]);
}

// The Cursor CLI keeps its sign-in apart from the Cursor app, in a lower-case folder.
export function cursorAgentHome(): string {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'cursor']);
}

export function openCodeAuthPath(): string {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode', 'auth.json']);
}

// Normalized providers always hold valid paths, so this never throws for them.
export function providerPaths(instance: ProviderInstance): ProviderPaths {
    if (instance.app === 'opencode')
        return {authFile: openCodeAuthPath(), historyDirectories: []};
    // A pasted key lives in the keyring; there is no file to read.
    if (instance.app === 'keyring')
        return {authFile: '', historyDirectories: []};
    const home = expandPath(instance.accountHome);
    const authName = instance.app === 'cursor-agent' ? 'auth.json' : AUTH_FILES[instance.kind];
    const authFile = instance.authFileOverride
        ? expandPath(instance.authFileOverride)
        : GLib.build_filenamev([home, authName]);
    const historyDirectories = instance.sessionsDirectoryOverride
        ? [expandPath(instance.sessionsDirectoryOverride)]
        : HISTORY_DIRECTORIES[instance.kind].map(name => GLib.build_filenamev([home, name]));
    return {authFile, historyDirectories};
}

// The files tried for an account's credentials, in order of preference.
export function authFileCandidates(instance: ProviderInstance): string[] {
    if (instance.kind !== 'antigravity' || instance.authFileOverride)
        return [providerPaths(instance).authFile];
    const home = expandPath(instance.accountHome);
    return ANTIGRAVITY_AUTH_FILES.map(name => GLib.build_filenamev([home, name]));
}

// Preferences process only: a small, user-triggered synchronous check.
export function pathExists(path: string): boolean {
    return Gio.File.new_for_path(path).query_exists(null);
}
