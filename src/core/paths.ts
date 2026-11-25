import GLib from 'gi://GLib';

import type {ProviderKind} from './types.js';

const DEFAULT_HOMES: Record<ProviderKind, string[]> = {
    codex: ['.codex'],
    claude: ['.claude'],
    kiro: [],
    antigravity: ['.gemini', 'antigravity-cli'],
    copilot: [],
    'opencode-go': [],
    deepseek: ['.claude'],
    kimi: ['.kimi-code'],
    cursor: [],
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
    // The GitHub CLI follows XDG_CONFIG_HOME.
    if (kind === 'copilot')
        return GLib.build_filenamev([GLib.get_user_config_dir(), 'gh']);
    return GLib.build_filenamev([GLib.get_home_dir(), ...DEFAULT_HOMES[kind]]);
}

// The Cursor CLI keeps its sign-in apart from the Cursor app, in a lower-case folder.
export function cursorAgentHome(): string {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'cursor']);
}
