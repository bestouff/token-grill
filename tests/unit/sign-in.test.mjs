import test from 'node:test';
import assert from 'node:assert/strict';
import {UNTRANSLATED} from './untranslated.mjs';
import {errorText} from '../../build/tests/popup-model.mjs';
import {signInCommand} from '../../build/tests/sign-in.mjs';

// The service says whether the account lives in the default home of its CLI.
test('the default home signs in with the plain command', () => {
    assert.deepEqual(signInCommand({app: 'codex-cli', accountHome: '~/.codex'}, true).argv, ['codex', 'login']);
    assert.deepEqual(signInCommand({app: 'claude-code', accountHome: '~/.claude'}, true).argv, ['claude', 'auth', 'login']);
    assert.deepEqual(signInCommand({app: 'cursor-agent', accountHome: '~/.config/cursor'}, true).argv, ['agent', 'login']);
    assert.deepEqual(signInCommand({app: 'opencode', accountHome: '~/.local/share/opencode'}, true).argv, ['opencode', 'auth', 'login']);
});

test('another home is passed through the CLI\'s own variable, without a shell', () => {
    assert.deepEqual(signInCommand({app: 'codex-cli', accountHome: '~/.codex-work'}, false).argv,
        ['env', 'CODEX_HOME=/home/test/.codex-work', 'codex', 'login']);
    assert.deepEqual(signInCommand({app: 'claude-code', accountHome: '/home/test/my claude'}, false).argv,
        ['env', 'CLAUDE_CONFIG_DIR=/home/test/my claude', 'claude', 'auth', 'login']);
    assert.deepEqual(signInCommand({app: 'github-cli', accountHome: '~/gh-work'}, false).argv,
        ['env', 'GH_CONFIG_DIR=/home/test/gh-work', 'gh', 'auth', 'login']);
});

test('apps that cannot be pointed at another home, or have no login command, get no button', () => {
    assert.equal(signInCommand({app: 'cursor-agent', accountHome: '~/other'}, false), null);
    assert.equal(signInCommand({app: 'kiro-cli', accountHome: '~/other'}, false), null);
    assert.equal(signInCommand({app: 'cursor', accountHome: '~/.config/Cursor'}, true), null);
    assert.equal(signInCommand({app: 'keyring', accountHome: ''}, true), null);
});

test('the hint names the variable for an account in another home', () => {
    const errorInfo = {code: 'auth-missing', messageId: 'codex.auth-missing', params: {}, recovery: 'reauthenticate'};
    assert.equal(errorText(UNTRANSLATED, {errorInfo, homeIsDefault: false}, {kind: 'codex', app: 'codex-cli', accountHome: '~/.codex-work'}),
        'Codex is not signed in. Run codex login with CODEX_HOME set to ~/.codex-work.');
    assert.equal(errorText(UNTRANSLATED, {errorInfo, homeIsDefault: true}, {kind: 'codex', app: 'codex-cli', accountHome: '~/.codex'}),
        'Codex is not signed in. Run codex login.');
});

test('an app name from the bus that is a member of every object gets no button', () => {
    for (const app of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
        assert.equal(signInCommand({app, accountHome: '~/.codex'}, true), null, app);
});
