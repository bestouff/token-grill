// The service names each failure by a message id with parameters and sends no text, so the
// sentence is translated here and follows the user's language. The msgids are the earlier ones,
// so the existing translations still apply.
import {formatText, type Translator} from './i18n.js';
import type {ClientStatus} from './serviceState.js';
import type {ErrorInfo, ProviderErrorCode} from './types.js';

interface ServiceMessage {
    text: (tr: Translator) => string;
    // The names of the parameters, in the order of the placeholders.
    params?: readonly string[];
}

const MESSAGES: Readonly<Record<string, ServiceMessage>> = {
    'net.offline': {text: ({_}) => _('The service could not be reached.')},
    'net.timed-out': {text: ({_}) => _('The service did not answer in time.')},
    'net.tls-failed': {text: ({_}) => _('A secure connection to the service could not be established.')},
    'net.too-large': {text: ({_}) => _('The service sent an unexpectedly large response.')},
    'net.invalid-json': {text: ({_}) => _('The service sent a response that could not be read.')},
    'net.not-allowed': {text: ({_}) => _('The request was blocked because its destination is not a known service host.')},
    'net.no-usage': {text: ({_}) => _('The service response did not contain any usage limits.')},
    'net.http-status': {text: ({_}) => _('The service answered with HTTP %d (%s).'), params: ['status', 'reason']},
    'net.http-status-bare': {text: ({_}) => _('The service answered with HTTP %d.'), params: ['status']},
    'config.no-credentials': {text: ({_}) => _('No credentials were found at %s.'), params: ['path']},
    'config.not-allowed': {text: ({_}) => _('Token Grill is not allowed to read %s.'), params: ['path']},
    'config.unreadable': {text: ({_}) => _('%s could not be read.'), params: ['path']},
    'config.not-credential-file': {text: ({_}) => _('%s is not a credential file.'), params: ['path']},
    'config.invalid-credentials': {text: ({_}) => _('%s does not contain valid credentials.'), params: ['path']},
    'history.update-failed': {text: ({_}) => _('The local usage history could not be updated.')},
    'service.internal': {text: ({_}) => _('Token Grill hit an unexpected error.')},
    'antigravity.auth-missing': {text: ({_}) => _('Antigravity is not signed in.')},
    'antigravity.agy-expired': {text: ({_}) => _('The agy sign-in has expired.')},
    'antigravity.auth-expired': {text: ({_}) => _('The Antigravity sign-in has expired.')},
    'antigravity.keyring-unavailable': {text: ({_}) => _('The system keyring is locked or not available, so the agy sign-in cannot be read.')},
    'antigravity.keyring-unreadable': {text: ({_}) => _('The agy sign-in in the system keyring could not be read.')},
    'claude.auth-missing': {text: ({_}) => _('Claude Code is not signed in.')},
    'claude.auth-expired': {text: ({_}) => _('The Claude Code sign-in has expired.')},
    'codex.auth-missing': {text: ({_}) => _('Codex is not signed in.')},
    'codex.auth-expired': {text: ({_}) => _('The Codex sign-in has expired.')},
    'codex.no-reset-credits': {text: ({_}) => _('The service response did not contain reset credits.')},
    'copilot.keyring-unavailable': {text: ({_}) => _('The system keyring is locked or not available, so the GitHub sign-in cannot be read.')},
    'copilot.github-cli-missing': {text: ({_}) => _('The GitHub CLI is not signed in.')},
    'copilot.cli-missing': {text: ({_}) => _('The Copilot CLI is not signed in.')},
    'copilot.no-limit': {text: ({_}) => _('This GitHub account has no Copilot usage limit.')},
    'cursor.auth-missing': {text: ({_}) => _('Cursor is not signed in.')},
    'cursor.encrypted': {text: ({_}) => _('Cursor keeps this sign-in encrypted, so Token Grill cannot read it.')},
    'cursor.database-unreadable': {text: ({_}) => _('The Cursor database at %s could not be read.'), params: ['path']},
    'cursor.cli-missing': {text: ({_}) => _('The Cursor CLI is not signed in.')},
    'cursor.auth-expired': {text: ({_}) => _('The Cursor sign-in has expired.')},
    'deepseek.keyring-unavailable': {text: ({_}) => _('The system keyring is locked or not available, so the DeepSeek API key cannot be read.')},
    'deepseek.key-missing': {text: ({_}) => _('No DeepSeek API key was found.')},
    'kimi.opencode-key-missing': {text: ({_}) => _('OpenCode has no Kimi Code key.')},
    'kimi.auth-missing': {text: ({_}) => _('Kimi Code is not signed in.')},
    'kimi.auth-expired': {text: ({_}) => _('The Kimi Code sign-in has expired.')},
    'kiro.auth-missing': {text: ({_}) => _('kiro-cli is not signed in.')},
    'kiro.database-unreadable': {text: ({_}) => _('The kiro-cli database at %s could not be read.'), params: ['path']},
    'kiro.auth-unreadable': {text: ({_}) => _('The kiro-cli sign-in data could not be read.')},
    'kiro.auth-expired': {text: ({_}) => _('The kiro-cli sign-in has expired.')},
    'kiro.region-unsupported': {text: ({_}) => _('Kiro usage is not available in the %s region.'), params: ['name']},
    'kiro.region-invalid': {text: ({_}) => _('The kiro-cli sign-in names an invalid region.')},
    'kiro.no-usage-account': {text: ({_}) => _('kiro-cli is signed in to an account without Kiro usage.')},
    'opencode-go.key-missing': {text: ({_}) => _('OpenCode has no OpenCode Go key.')},
    'opencode-go.no-subscription': {text: ({_}) => _('This OpenCode key has no Go subscription.')},
    'opencode.auth-missing': {text: ({_}) => _('OpenCode is not signed in to this service.')},
    'opencode.api-key-only': {text: ({_}) => _('OpenCode holds an API key for this service, not a sign-in.')},
    'opencode.auth-expired': {text: ({_}) => _('The OpenCode sign-in has expired.')},
    'opencode.copilot-missing': {text: ({_}) => _('OpenCode is not signed in to GitHub Copilot.')},
};

export const SERVICE_MESSAGE_IDS: readonly string[] = Object.keys(MESSAGES);

// The text for a message id this extension does not know: a newer service may add ids.
export function codeMessage({_}: Translator, code: ProviderErrorCode): string {
    const texts: Record<ProviderErrorCode, string> = {
        'auth-missing': _('The account is not signed in.'),
        'auth-expired': _('The sign-in has expired.'),
        'auth-invalid': _('The sign-in was not accepted.'),
        'unsupported-account': _('This account type is not supported.'),
        dependency: _('A library that this account needs is missing.'),
        permission: _('Token Grill is not allowed to read the sign-in.'),
        offline: _('The service could not be reached.'),
        timeout: _('The service did not answer in time.'),
        'rate-limited': _('The service is limiting requests.'),
        http: _('The service answered with an error.'),
        'response-shape': _('The service sent a response that could not be read.'),
        'local-history': _('The local usage history could not be updated.'),
        internal: _('Token Grill could not read this account.'),
    };
    return texts[code];
}

export function serviceMessage(tr: Translator, info: ErrorInfo): string {
    const message = Object.hasOwn(MESSAGES, info.messageId) ? MESSAGES[info.messageId] : undefined;
    if (!message)
        return codeMessage(tr, info.code);
    const values = (message.params ?? []).map(name => Object.hasOwn(info.params, name) ? info.params[name] : undefined);
    if (values.some(value => typeof value !== 'string'))
        return codeMessage(tr, info.code);
    return formatText(message.text(tr), ...values as string[]);
}

export type ServiceFailure = Exclude<ClientStatus, 'connecting' | 'connected'>;

export interface ServiceCardPart {
    kind: 'title' | 'body' | 'hint' | 'command' | 'check-again';
    text: string;
}

// Commands are shell input and stay untranslated; the sentences around them are translated.
const INSTALL_WITH_PIPX = 'pipx install tokengrill && ~/.local/bin/tokengrill setup';
const INSTALL_WITH_UV = 'uv tool install tokengrill && ~/.local/bin/tokengrill setup';
const UPGRADE_WITH_PIPX = 'pipx upgrade tokengrill';
// dbus-daemon logs an activated service under its bus name; dbus-broker under the name of the program,
// which `tokengrill setup` makes the tokengrill script.
const SHOW_THE_LOG = 'journalctl --user -t io.github.sh02sahil.TokenGrill -t tokengrill';

// The card that the popup and Preferences show while the service cannot be used, in reading order.
export function serviceStatusContent({_}: Translator, failure: ServiceFailure): ServiceCardPart[] {
    const cards: Record<ServiceFailure, ServiceCardPart[]> = {
        missing: [
            {kind: 'title', text: _('Token Grill Needs Its Service')},
            {kind: 'body', text: _('The service reads your sign-ins and asks each service for your usage')},
            {kind: 'command', text: INSTALL_WITH_PIPX},
            {kind: 'hint', text: formatText(_('No pipx? Install it with %s (Ubuntu, Debian) or %s (Fedora)'), 'sudo apt install pipx', 'sudo dnf install pipx')},
            {kind: 'command', text: INSTALL_WITH_UV},
            {kind: 'check-again', text: _('Check Again')},
        ],
        'too-old': [
            {kind: 'title', text: _('Update the Service')},
            {kind: 'command', text: UPGRADE_WITH_PIPX},
            {kind: 'check-again', text: _('Check Again')},
        ],
        'not-responding': [
            {kind: 'title', text: _('The Service Is Not Responding')},
            {kind: 'check-again', text: _('Check Again')},
            {kind: 'command', text: SHOW_THE_LOG},
        ],
    };
    return cards[failure];
}
