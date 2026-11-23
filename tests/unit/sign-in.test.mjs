import test from 'node:test';
import assert from 'node:assert/strict';
import {UNTRANSLATED} from '../../build/tests/i18n.mjs';
import {errorText} from '../../build/tests/popup-model.mjs';
import {signInCommand} from '../../build/tests/sign-in.mjs';

test('the default home signs in with the plain command', () => {
    assert.deepEqual(signInCommand({app: 'codex-cli', accountHome: '~/.codex'}).argv, ['codex', 'login']);
    assert.deepEqual(signInCommand({app: 'claude-code', accountHome: '~/.claude'}).argv, ['claude', 'auth', 'login']);
    assert.deepEqual(signInCommand({app: 'cursor-agent', accountHome: '~/.config/cursor'}).argv, ['agent', 'login']);
    assert.deepEqual(signInCommand({app: 'opencode', accountHome: '~/.local/share/opencode'}).argv, ['opencode', 'auth', 'login']);
});

test('another home is passed through the CLI\'s own variable, without a shell', () => {
    assert.deepEqual(signInCommand({app: 'codex-cli', accountHome: '~/.codex-work'}).argv,
        ['env', 'CODEX_HOME=/home/test/.codex-work', 'codex', 'login']);
    assert.deepEqual(signInCommand({app: 'claude-code', accountHome: '/home/test/my claude'}).argv,
        ['env', 'CLAUDE_CONFIG_DIR=/home/test/my claude', 'claude', 'auth', 'login']);
});

test('apps that cannot be pointed at another home, or have no login command, get no button', () => {
    assert.equal(signInCommand({app: 'cursor-agent', accountHome: '~/other'}), null);
    assert.equal(signInCommand({app: 'cursor', accountHome: '~/.config/Cursor'}), null);
    assert.equal(signInCommand({app: 'keyring', accountHome: ''}), null);
});

test('the hint names the variable for an account in another home', () => {
    const snapshot = {error: 'Codex is not signed in.', errorInfo: {code: 'auth-missing', message: '', recovery: 'reauthenticate'}};
    assert.equal(errorText(UNTRANSLATED, snapshot, {kind: 'codex', app: 'codex-cli', accountHome: '~/.codex-work'}),
        'Codex is not signed in. Run codex login with CODEX_HOME set to ~/.codex-work.');
    assert.equal(errorText(UNTRANSLATED, snapshot, {kind: 'codex', app: 'codex-cli', accountHome: '~/.codex'}),
        'Codex is not signed in. Run codex login.');
});
