import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import type {ProviderInstance, ProviderKind, ProviderPaths} from './types.js';

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
    return value === home ? '~' : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

export function providerPaths(instance: ProviderInstance): ProviderPaths {
    const home = expandPath(instance.accountHome);
    const authFile = instance.authFileOverride ? expandPath(instance.authFileOverride) :
        instance.kind === 'antigravity' ?
            (pathExists(GLib.build_filenamev([home, 'acp_token.json'])) ? GLib.build_filenamev([home, 'acp_token.json']) :
             pathExists(GLib.build_filenamev([home, 'oauth_creds.json'])) ? GLib.build_filenamev([home, 'oauth_creds.json']) :
             pathExists(GLib.build_filenamev([home, 'credentials.json'])) ? GLib.build_filenamev([home, 'credentials.json']) :
             GLib.build_filenamev([home, 'acp_token.json'])) :
        GLib.build_filenamev([home, instance.kind === 'codex' ? 'auth.json' : instance.kind === 'claude' ? '.credentials.json' : 'data.sqlite3']);
    const sessionsDirectory = instance.sessionsDirectoryOverride ? expandPath(instance.sessionsDirectoryOverride) :
        instance.kind === 'kiro' ? GLib.build_filenamev([GLib.get_home_dir(), '.kiro', 'sessions']) :
        instance.kind === 'antigravity' ? GLib.build_filenamev([home, 'conversations']) :
            GLib.build_filenamev([home, instance.kind === 'codex' ? 'sessions' : 'projects']);
    const archivedSessionsDirectory = (instance.kind === 'kiro' || instance.kind === 'antigravity') ? sessionsDirectory : GLib.build_filenamev([home, 'archived_sessions']);
    const configFile = instance.kind === 'kiro' ? GLib.build_filenamev([GLib.get_home_dir(), '.kiro', 'settings', 'cli.json']) :
        instance.kind === 'antigravity' ? GLib.build_filenamev([home, 'settings.json']) :
        GLib.build_filenamev([home, instance.kind === 'codex' ? 'config.toml' : 'config.json']);
    return {authFile, sessionsDirectory, archivedSessionsDirectory, configFile};
}

export function pathExists(path: string): boolean {
    return Gio.File.new_for_path(path).query_exists(null);
}

export function isDirectory(path: string): boolean {
    try {
        const info = Gio.File.new_for_path(path).query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_file_type() === Gio.FileType.DIRECTORY;
    } catch {
        return false;
    }
}

export function defaultHome(kind: ProviderKind): string {
    if (kind === 'kiro') return GLib.build_filenamev([GLib.get_user_data_dir(), 'kiro-cli']);
    if (kind === 'antigravity') {
        const geminiAntigravity = GLib.build_filenamev([GLib.get_home_dir(), '.gemini', 'antigravity']);
        if (pathExists(geminiAntigravity)) return geminiAntigravity;
        const dotAntigravity = GLib.build_filenamev([GLib.get_home_dir(), '.antigravity']);
        if (pathExists(dotAntigravity)) return dotAntigravity;
        return GLib.build_filenamev([GLib.get_home_dir(), '.antigravity']);
    }
    return GLib.build_filenamev([GLib.get_home_dir(), kind === 'codex' ? '.codex' : '.claude']);
}
