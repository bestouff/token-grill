import {expandPath} from './paths.js';
import type {AccountApp, ProviderInstance} from './types.js';

interface LoginCommand {
    argv: string[];
    // The variable that points the CLI at another home. A CLI without one is
    // offered only for its default home.
    homeVariable: string | null;
}

// The service's core/paths.py knows the default home of each of these CLIs.
const COMMANDS: Partial<Record<AccountApp, LoginCommand>> = {
    'codex-cli': {argv: ['codex', 'login'], homeVariable: 'CODEX_HOME'},
    'claude-code': {argv: ['claude', 'auth', 'login'], homeVariable: 'CLAUDE_CONFIG_DIR'},
    'github-cli': {argv: ['gh', 'auth', 'login'], homeVariable: 'GH_CONFIG_DIR'},
    'kiro-cli': {argv: ['kiro-cli', 'login'], homeVariable: null},
    'cursor-agent': {argv: ['agent', 'login'], homeVariable: null},
    opencode: {argv: ['opencode', 'auth', 'login'], homeVariable: null},
};

export interface SignInCommand {
    argv: string[];
    // The login command alone, as the hint text names it.
    login: string;
    // The variable and home a non-default account needs, for the hint text.
    home: {variable: string; path: string} | null;
}

// The command that signs this account in again in a terminal, or null when
// Token Grill cannot start the right one. The service tells whether the
// account lives in the default home of its CLI.
export function signInCommand(instance: Pick<ProviderInstance, 'app' | 'accountHome'>, homeIsDefault: boolean): SignInCommand | null {
    // The app comes from the bus, so only the table's own keys count.
    const command = Object.hasOwn(COMMANDS, instance.app) ? COMMANDS[instance.app] : undefined;
    if (!command)
        return null;
    const login = command.argv.join(' ');
    if (homeIsDefault)
        return {argv: command.argv, login, home: null};
    if (!command.homeVariable)
        return null;
    const home = expandPath(instance.accountHome);
    // `env` sets the variable without a shell, so the path needs no quoting rules of its own.
    return {argv: ['env', `${command.homeVariable}=${home}`, ...command.argv], login, home: {variable: command.homeVariable, path: home}};
}
