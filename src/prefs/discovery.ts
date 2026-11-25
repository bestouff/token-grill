import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {newProvider} from '../core/config.js';
import {authFileCandidates, cursorAgentHome, defaultHome, pathExists, providerPaths} from '../core/paths.js';
import {providerMetadata} from '../core/providerMetadata.js';
import type {ProviderInstance, ProviderKind} from '../core/types.js';

function hasCredentials(provider: ProviderInstance): boolean {
    return authFileCandidates(provider).some(pathExists);
}

// Directories in the home folder whose names start with the prefix, such as ~/.codex-work.
function prefixedDirectories(prefix: string): string[] {
    const home = Gio.File.new_for_path(GLib.get_home_dir());
    const enumerator = home.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    const names: string[] = [];
    for (const info of enumerator) {
        if (info.get_file_type() === Gio.FileType.DIRECTORY && info.get_name().startsWith(prefix))
            names.push(info.get_name());
    }
    enumerator.close(null);
    return names.sort();
}

// A second Codex or Claude account lives in its own home such as ~/.codex-work,
// so the suffix is the only name it has. Other folders keep the service name.
export function homeName(kind: ProviderKind, folder: string): string {
    const label = providerMetadata(kind).label;
    const prefix = `.${kind}`;
    return folder.startsWith(prefix) && folder !== prefix ? `${label}${folder.slice(prefix.length)}` : label;
}

export function cliHomes(kind: 'codex' | 'claude'): ProviderInstance[] {
    const prefix = `.${kind}`;
    const providers: ProviderInstance[] = [];
    for (const name of prefixedDirectories(prefix)) {
        const provider = newProvider(kind, providerMetadata(kind).apps[0], `~/${name}`);
        if (!hasCredentials(provider) && !providerPaths(provider).historyDirectories.some(pathExists))
            continue;
        provider.displayName = homeName(kind, name);
        providers.push(provider);
    }
    return providers;
}

export function antigravityHomes(): ProviderInstance[] {
    const home = GLib.get_home_dir();
    // The agy CLI keeps its token in the keyring, so its home is recognised by its own state files.
    const cliHome = GLib.build_filenamev([home, '.gemini', 'antigravity-cli']);
    const cliMarkers = ['settings.json', 'installation_id'].map(name => GLib.build_filenamev([cliHome, name]));
    const providers = [];
    if (cliMarkers.some(pathExists))
        providers.push(newProvider('antigravity', 'antigravity', cliHome));
    const otherHomes = [
        GLib.build_filenamev([home, '.gemini', 'antigravity']),
        GLib.build_filenamev([home, '.antigravity']),
        GLib.build_filenamev([home, '.config', 'Antigravity']),
    ];
    for (const path of otherHomes) {
        const provider = newProvider('antigravity', 'antigravity', path);
        if (hasCredentials(provider))
            providers.push(provider);
    }
    return providers;
}

export function kiroHomes(): ProviderInstance[] {
    const provider = newProvider('kiro', 'kiro-cli', defaultHome('kiro'));
    return hasCredentials(provider) ? [provider] : [];
}

export function kimiHomes(): ProviderInstance[] {
    const provider = newProvider('kimi', 'kimi-cli', defaultHome('kimi'));
    return hasCredentials(provider) ? [provider] : [];
}

export function cursorHomes(): ProviderInstance[] {
    const provider = newProvider('cursor', 'cursor', defaultHome('cursor'));
    return hasCredentials(provider) ? [provider] : [];
}

export function cursorAgentHomes(): ProviderInstance[] {
    const provider = newProvider('cursor', 'cursor-agent', cursorAgentHome());
    return hasCredentials(provider) ? [provider] : [];
}

export function githubCliHomes(): ProviderInstance[] {
    const provider = newProvider('copilot', 'github-cli', defaultHome('copilot'));
    return hasCredentials(provider) ? [provider] : [];
}
