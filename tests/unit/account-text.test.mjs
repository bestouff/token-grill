import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {credentialLabel, homeName} from '../../build/tests/account-text.mjs';
import {UNTRANSLATED} from './untranslated.mjs';

// The service reports the 0.4.1 state names, so Preferences keep the 0.4.1 texts.
const LABELS = {
    authenticated: 'Authenticated',
    expired: 'Sign-in expired',
    'expired-refreshable': 'Sign-in expired, renewed automatically',
    'expired-external': 'Token expired; run any agy command to refresh',
    'login-required': 'Sign-in required',
    unreadable: 'Credential unreadable',
    'database-unreadable': 'Database unreadable',
    'keyring-unavailable': 'System keyring locked or unavailable',
};

test('every credential state of the service has its 0.4.1 label', () => {
    for (const [state, label] of Object.entries(LABELS))
        assert.equal(credentialLabel(UNTRANSLATED, state), label, state);
});

test('the service states are exactly the ones Preferences have words for', async () => {
    const source = await readFile(new URL('../../service/src/tokengrill/providers/credential_state.py', import.meta.url), 'utf8');
    const block = source.match(/CredentialState = Literal\[([\s\S]*?)\]/)[1];
    const states = [...block.matchAll(/"([a-z-]+)"/g)].map(match => match[1]);
    assert.deepEqual(states.sort(), Object.keys(LABELS).sort());
});

test('a state that this version has no words for has no label', () => {
    for (const state of ['gda-missing', 'something-new', '', 'toString', '__proto__', 'constructor'])
        assert.equal(credentialLabel(UNTRANSLATED, state), null, state);
});

test('the labels go through gettext with literal msgids', () => {
    const seen = [];
    const translate = text => {
        seen.push(text);
        return `[${text}]`;
    };
    const tr = {_: translate, ngettext: UNTRANSLATED.ngettext};
    assert.equal(credentialLabel(tr, 'expired'), '[Sign-in expired]');
    assert.deepEqual(seen, ['Sign-in expired']);
});

test('an account added by its folder is named after the folder suffix, as in 0.4.1', () => {
    assert.equal(homeName('codex', '.codex-work'), 'Codex-work');
    assert.equal(homeName('claude', '.claude-personal'), 'Claude-personal');
    assert.equal(homeName('codex', '.codex'), 'Codex');
    assert.equal(homeName('codex', 'work'), 'Codex');
    assert.equal(homeName('kiro', '.kiro-x'), 'Kiro-x');
    assert.equal(homeName('antigravity', 'antigravity-cli'), 'Antigravity');
});
