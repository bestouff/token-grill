import {expandPath} from './paths.js';
import type {AccountApp, ProviderInstance} from './types.js';

type LoginApp = 'codex-cli' | 'claude-code' | 'github-cli' | 'kiro-cli' | 'cursor-agent' | 'opencode' | 'copilot-cli';

interface LoginCommand {
    argv: string[];
    // The variable that points the CLI at another home. A CLI without one is
    // offered only for its default home.
    homeVariable: string | null;
    // copilot signs in with /login inside its own session: starting it signs
    // nothing in, so it gets no terminal button.
    inSession: boolean;
}

// The one place that names the login command of each CLI: the terminal
// button, the hints of the popup and of Preferences all read it. The
// service's core/paths.py knows the default home of each of these CLIs.
const COMMANDS: Record<LoginApp, LoginCommand> = {
    'codex-cli': {argv: ['codex', 'login'], homeVariable: 'CODEX_HOME', inSession: false},
    'claude-code': {argv: ['claude', 'auth', 'login'], homeVariable: 'CLAUDE_CONFIG_DIR', inSession: false},
    'github-cli': {argv: ['gh', 'auth', 'login'], homeVariable: 'GH_CONFIG_DIR', inSession: false},
    'kiro-cli': {argv: ['kiro-cli', 'login'], homeVariable: null, inSession: false},
    'cursor-agent': {argv: ['agent', 'login'], homeVariable: null, inSession: false},
    opencode: {argv: ['opencode', 'auth', 'login'], homeVariable: null, inSession: false},
    'copilot-cli': {argv: ['copilot'], homeVariable: null, inSession: true},
};

// The app comes from the bus, so only the table's own keys count.
export function hasLoginCommand(app: AccountApp): app is LoginApp {
    return Object.hasOwn(COMMANDS, app);
}

// The command as a hint names it; it is not translated.
export function loginCommand(app: LoginApp): string {
    return COMMANDS[app].argv.join(' ');
}

interface SignInCommand {
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
    if (!hasLoginCommand(instance.app))
        return null;
    const command = COMMANDS[instance.app];
    if (command.inSession)
        return null;
    const login = loginCommand(instance.app);
    if (homeIsDefault)
        return {argv: command.argv, login, home: null};
    if (!command.homeVariable)
        return null;
    const home = expandPath(instance.accountHome);
    // `env` sets the variable without a shell, so the path needs no quoting rules of its own.
    return {argv: ['env', `${command.homeVariable}=${home}`, ...command.argv], login, home: {variable: command.homeVariable, path: home}};
}
