import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CollectorError} from '../core/errors.js';
import {isCancellation} from '../core/gio.js';
import {expandPath, providerPaths} from '../core/paths.js';
import {providerMetadata} from '../core/providerMetadata.js';
import type {AccountApp, ProviderInstance} from '../core/types.js';
import {duplicateOf, identityFromCodexAuth, identityFromOpenCode, type AccountIdentity} from '../providers/accountIdentity.js';
import {byStatus, openCodeCandidates, type Candidate} from '../providers/candidates.js';
import {copilotCliToken} from '../providers/copilot/auth.js';
import {readCredentialJson} from '../providers/credentials.js';
import {deepSeekKeyFromClaudeSettings} from '../providers/deepseek/normalize.js';
import {readOpenCodeEntries} from '../providers/opencode/authFile.js';
import type {OpenCodeEntry} from '../providers/opencode/entries.js';
import {antigravityHomes, cliHomes, cursorAgentHomes, cursorHomes, githubCliHomes, kimiHomes, kiroHomes} from './discovery.js';

// A sign-in that cannot be read is simply not offered.
async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
    try {
        return await read();
    } catch (error) {
        if (isCancellation(error) || !(error instanceof CollectorError))
            throw error;
        return null;
    }
}

function sameHome(a: string, b: string): boolean {
    return Boolean(a && b) && expandPath(a) === expandPath(b);
}

async function openCodeEntries(cancellable: Gio.Cancellable): Promise<Map<string, OpenCodeEntry>> {
    return await readOrNull(() => readOpenCodeEntries(cancellable)) ?? new Map();
}

async function codexIdentity(provider: ProviderInstance, cancellable: Gio.Cancellable): Promise<AccountIdentity | null> {
    const payload = await readOrNull(() => readCredentialJson(providerPaths(provider).authFile, cancellable));
    return payload ? identityFromCodexAuth(payload) : null;
}

// Only a Codex sign-in carries an account identity, so only Codex accounts can
// be matched against a sign-in found elsewhere.
async function configuredIdentities(configured: ProviderInstance[], entries: Map<string, OpenCodeEntry>, cancellable: Gio.Cancellable): Promise<Map<string, AccountIdentity | null>> {
    const openAi = entries.get('openai');
    const fromOpenCode = openAi ? identityFromOpenCode('openai', openAi) : null;
    const codex = configured.filter(provider => provider.kind === 'codex');
    return new Map(await Promise.all(codex.map(async (provider): Promise<[string, AccountIdentity | null]> =>
        [provider.id, provider.app === 'opencode' ? fromOpenCode : await codexIdentity(provider, cancellable)])));
}

async function homeCandidates(
    found: ProviderInstance[],
    configured: ProviderInstance[],
    identities: Map<string, AccountIdentity | null>,
    cancellable: Gio.Cancellable
): Promise<Candidate[]> {
    const candidates = await Promise.all(found.map(async (provider): Promise<Candidate> => {
        const added = configured.some(item => item.app === provider.app && sameHome(item.accountHome, provider.accountHome));
        const identity = !added && provider.kind === 'codex' ? await codexIdentity(provider, cancellable) : null;
        return {
            kind: provider.kind,
            app: provider.app,
            accountHome: provider.accountHome,
            label: provider.displayName,
            status: added ? 'already-added' : 'ready',
            duplicateOf: duplicateOf(identity, identities),
        };
    }));
    return byStatus(candidates);
}

// Claude Code homes whose settings send Claude Code to DeepSeek with an API key.
async function claudeSettingsCandidates(configured: ProviderInstance[], cancellable: Gio.Cancellable): Promise<Candidate[]> {
    const homes = await Promise.all(cliHomes('claude').map(async home => {
        const settings = await readOrNull(() => readCredentialJson(GLib.build_filenamev([expandPath(home.accountHome), 'settings.json']), cancellable));
        return settings && deepSeekKeyFromClaudeSettings(settings) ? [home] : [];
    }));
    return homes.flat().map((home): Candidate => ({
        kind: 'deepseek',
        app: 'claude-settings',
        accountHome: home.accountHome,
        label: providerMetadata('deepseek').label,
        status: configured.some(item => item.app === 'claude-settings' && sameHome(item.accountHome, home.accountHome)) ? 'already-added' : 'ready',
        duplicateOf: null,
    }));
}

async function copilotCliCandidates(configured: ProviderInstance[], cancellable: Gio.Cancellable): Promise<Candidate[]> {
    const token = await readOrNull(() => copilotCliToken(cancellable));
    if (!token)
        return [];
    const added = configured.some(item => item.app === 'copilot-cli');
    return [{kind: 'copilot', app: 'copilot-cli', accountHome: '~/.copilot', label: providerMetadata('copilot').label, status: added ? 'already-added' : 'ready', duplicateOf: null}];
}

interface Search {
    configured: ProviderInstance[];
    identities: Map<string, AccountIdentity | null>;
    entries: Map<string, OpenCodeEntry>;
    cancellable: Gio.Cancellable;
}

const FINDERS: Record<AccountApp, (search: Search) => Promise<Candidate[]>> = {
    'codex-cli': search => homeCandidates(cliHomes('codex'), search.configured, search.identities, search.cancellable),
    'claude-code': search => homeCandidates(cliHomes('claude'), search.configured, search.identities, search.cancellable),
    'kiro-cli': search => homeCandidates(kiroHomes(), search.configured, search.identities, search.cancellable),
    antigravity: search => homeCandidates(antigravityHomes(), search.configured, search.identities, search.cancellable),
    'kimi-cli': search => homeCandidates(kimiHomes(), search.configured, search.identities, search.cancellable),
    cursor: search => homeCandidates(cursorHomes(), search.configured, search.identities, search.cancellable),
    'cursor-agent': search => homeCandidates(cursorAgentHomes(), search.configured, search.identities, search.cancellable),
    'github-cli': search => homeCandidates(githubCliHomes(), search.configured, search.identities, search.cancellable),
    'copilot-cli': search => copilotCliCandidates(search.configured, search.cancellable),
    opencode: search => Promise.resolve(openCodeCandidates(search.entries, search.configured, search.identities,
        GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode']))),
    'claude-settings': search => claudeSettingsCandidates(search.configured, search.cancellable),
    // A pasted key is typed in, not found.
    keyring: () => Promise.resolve([]),
};

// Every account that can be added from one app, read-only and without network requests.
export async function findCandidates(app: AccountApp, configured: ProviderInstance[], cancellable: Gio.Cancellable): Promise<Candidate[]> {
    const entries = await openCodeEntries(cancellable);
    const identities = await configuredIdentities(configured, entries, cancellable);
    return FINDERS[app]({configured, identities, entries, cancellable});
}

// Discover: every app at once, sharing one read of OpenCode and the existing sign-ins.
export async function findAllCandidates(configured: ProviderInstance[], cancellable: Gio.Cancellable): Promise<Candidate[]> {
    const entries = await openCodeEntries(cancellable);
    const identities = await configuredIdentities(configured, entries, cancellable);
    const search = {configured, identities, entries, cancellable};
    const found = await Promise.all(Object.values(FINDERS).map(find => find(search)));
    return byStatus(found.flat());
}
