import {cursorAgentHome, defaultHome, expandPath} from './paths.js';
import type {AccountApp, ProviderInstance} from './types.js';

interface LoginCommand {
    argv: string[];
    // The variable that points the CLI at another home. A CLI without one is
    // offered only for its default home.
    homeVariable: string | null;
    // Null for an app that keeps one store for every account.
    defaultHome: (() => string) | null;
}

const COMMANDS: Partial<Record<AccountApp, LoginCommand>> = {
    'codex-cli': {argv: ['codex', 'login'], homeVariable: 'CODEX_HOME', defaultHome: () => defaultHome('codex')},
    'claude-code': {argv: ['claude', 'auth', 'login'], homeVariable: 'CLAUDE_CONFIG_DIR', defaultHome: () => defaultHome('claude')},
    'github-cli': {argv: ['gh', 'auth', 'login'], homeVariable: 'GH_CONFIG_DIR', defaultHome: () => defaultHome('copilot')},
    'kiro-cli': {argv: ['kiro-cli', 'login'], homeVariable: null, defaultHome: () => defaultHome('kiro')},
    'cursor-agent': {argv: ['agent', 'login'], homeVariable: null, defaultHome: cursorAgentHome},
    'opencode': {argv: ['opencode', 'auth', 'login'], homeVariable: null, defaultHome: null},
};

export interface SignInCommand {
    argv: string[];
    // The login command alone, as the hint text names it.
    login: string;
    // The variable and home a non-default account needs, for the hint text.
    home: {variable: string; path: string} | null;
}

// The command that signs this account in again in a terminal, or null when
// Token Grill cannot start the right one.
export function signInCommand(instance: Pick<ProviderInstance, 'app' | 'accountHome'>): SignInCommand | null {
    const command = COMMANDS[instance.app];
    if (!command)
        return null;
    const login = command.argv.join(' ');
    if (!command.defaultHome)
        return {argv: command.argv, login, home: null};
    const home = expandPath(instance.accountHome);
    if (home === command.defaultHome())
        return {argv: command.argv, login, home: null};
    if (!command.homeVariable)
        return null;
    // `env` sets the variable without a shell, so the path needs no quoting rules of its own.
    return {argv: ['env', `${command.homeVariable}=${home}`, ...command.argv], login, home: {variable: command.homeVariable, path: home}};
}
