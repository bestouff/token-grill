import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {UNTRANSLATED} from '../../build/tests/i18n.mjs';
import {codeMessage, SERVICE_MESSAGE_IDS, serviceMessage, serviceStatusContent} from '../../build/tests/service-messages.mjs';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

// The English text of each id in the service's catalog, read from the Python source.
async function catalog() {
    const source = await read('service/src/tokengrill/core/messages.py');
    const body = source.slice(source.indexOf('MESSAGES'));
    const entries = new Map();
    for (const match of body.matchAll(/"([a-z0-9-]+\.[a-z0-9-]+)":\s*\(?\s*"((?:[^"\\]|\\.)*)"/g))
        entries.set(match[1], match[2]);
    return entries;
}

const CODES = ['auth-missing', 'auth-expired', 'auth-invalid', 'unsupported-account', 'dependency', 'permission', 'offline',
    'timeout', 'rate-limited', 'http', 'response-shape', 'local-history', 'internal'];

const info = (messageId, params = {}, code = 'internal') => ({code, messageId, params, recovery: 'none'});

test('the table has exactly the message ids of the service', async () => {
    const entries = await catalog();
    assert.ok(entries.size > 50, 'the catalog regex found the entries');
    assert.deepEqual([...SERVICE_MESSAGE_IDS].sort(), [...entries.keys()].sort());
});

test('each message reads as the service text, with the parameters in place', async () => {
    for (const [id, text] of await catalog()) {
        const names = [...text.matchAll(/\{([a-z_]+)\}/g)].map(match => match[1]);
        const params = Object.fromEntries(names.map(name => [name, `<${name}>`]));
        const expected = text.replace(/\{([a-z_]+)\}/g, (_match, name) => `<${name}>`);
        assert.equal(serviceMessage(UNTRANSLATED, info(id, params)), expected, id);
    }
});

test('parameters keep the order of the 0.4.1 text', () => {
    assert.equal(serviceMessage(UNTRANSLATED, info('net.http-status', {reason: 'Bad Gateway', status: '502'})),
        'The service answered with HTTP 502 (Bad Gateway).');
    assert.equal(serviceMessage(UNTRANSLATED, info('config.not-allowed', {path: '~/.codex/auth.json'})),
        'Token Grill is not allowed to read ~/.codex/auth.json.');
    assert.equal(serviceMessage(UNTRANSLATED, info('kiro.region-unsupported', {name: 'eu-west-9'})),
        'Kiro usage is not available in the eu-west-9 region.');
});

test('an unknown id or a missing parameter gives the generic text of the code', () => {
    assert.equal(serviceMessage(UNTRANSLATED, info('codex.something-new', {}, 'offline')), 'The service could not be reached.');
    assert.equal(serviceMessage(UNTRANSLATED, info('toString', {}, 'timeout')), 'The service did not answer in time.');
    assert.equal(serviceMessage(UNTRANSLATED, info('__proto__', {}, 'timeout')), 'The service did not answer in time.');
    assert.equal(serviceMessage(UNTRANSLATED, info('config.no-credentials', {}, 'auth-missing')), 'The account is not signed in.');
});

test('every error code has a generic text, internal included', () => {
    for (const code of CODES) {
        const text = codeMessage(UNTRANSLATED, code);
        assert.equal(typeof text, 'string', code);
        assert.ok(text.length > 0, code);
    }
    assert.equal(serviceMessage(UNTRANSLATED, info('service.internal')), 'Token Grill hit an unexpected error.');
});

test('the message table uses literal msgids', async () => {
    const source = await read('src/core/serviceMessages.ts');
    assert.doesNotMatch(source, /_\(`/);
    assert.doesNotMatch(source, /_\([a-zA-Z]/);
    for (const text of (await catalog()).values()) {
        const msgid = text.replace(/\{status\}/, '%d').replace(/\{[a-z_]+\}/g, '%s');
        assert.ok(source.includes(`_('${msgid}')`), msgid);
    }
});

test('the service cards have the setup copy', () => {
    assert.deepEqual(serviceStatusContent(UNTRANSLATED, 'missing'), [
        {kind: 'title', text: 'Token Grill Needs Its Service'},
        {kind: 'body', text: 'The service reads your sign-ins and asks each service for your usage'},
        {kind: 'command', text: 'pipx install tokengrill && ~/.local/bin/tokengrill setup'},
        {kind: 'hint', text: 'No pipx? Install it with sudo apt install pipx (Ubuntu, Debian) or sudo dnf install pipx (Fedora)'},
        {kind: 'command', text: 'uv tool install tokengrill && ~/.local/bin/tokengrill setup'},
        {kind: 'check-again', text: 'Check Again'},
    ]);
    assert.deepEqual(serviceStatusContent(UNTRANSLATED, 'too-old'), [
        {kind: 'title', text: 'Update the Service'},
        {kind: 'command', text: 'pipx upgrade tokengrill'},
    ]);
    assert.deepEqual(serviceStatusContent(UNTRANSLATED, 'not-responding'), [
        {kind: 'title', text: 'The Service Is Not Responding'},
        {kind: 'check-again', text: 'Check Again'},
        {kind: 'command', text: 'journalctl --user -t io.github.sh02sahil.TokenGrill -t tokengrill'},
    ]);
});

test('card sentences go through gettext and the commands do not', async () => {
    const source = await read('src/core/serviceMessages.ts');
    for (const msgid of ['Token Grill Needs Its Service', 'The service reads your sign-ins and asks each service for your usage',
        'No pipx? Install it with %s (Ubuntu, Debian) or %s (Fedora)', 'Update the Service', 'The Service Is Not Responding', 'Check Again'])
        assert.ok(source.includes(`_('${msgid}')`), msgid);
    for (const command of ['pipx install tokengrill', 'uv tool install tokengrill', 'pipx upgrade tokengrill', 'journalctl --user', 'sudo apt install pipx'])
        assert.doesNotMatch(source, new RegExp(`_\\('[^']*${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), command);

    const [card, banner] = await Promise.all([read('src/shell/serviceCard.ts'), read('src/prefs/serviceBanner.ts')]);
    for (const [name, widget] of [['card', card], ['banner', banner]]) {
        assert.match(widget, /serviceStatusContent\(TRANSLATOR, /, name);
        // The only literal sentences are labels of the controls, and those go through gettext too.
        for (const match of widget.matchAll(/(?:label|text|title|tooltip_text|accessible_name):\s*'([^']+)'/g))
            assert.fail(`${name} has an untranslated text: ${match[1]}`);
    }
});

test('the copy buttons use the clipboard of their process and have accessible names', async () => {
    const [card, banner] = await Promise.all([read('src/shell/serviceCard.ts'), read('src/prefs/serviceBanner.ts')]);
    assert.match(card, /St\.Clipboard\.get_default\(\)\.set_text\(St\.ClipboardType\.CLIPBOARD, /);
    assert.match(card, /accessible_name: formatText\(_\('Copy %s'\), /);
    assert.match(card, /icon_name: 'edit-copy-symbolic'/);
    assert.match(banner, /Gdk\.Display\.get_default\(\)!\.get_clipboard\(\)\.set\(/);
    assert.match(banner, /setAccessibleLabel\(copy, formatText\(_\('Copy %s'\), /);
    assert.match(banner, /icon_name: 'edit-copy-symbolic'/);
    for (const source of [card, banner]) {
        assert.match(source, /\.retry\(\)|onCheckAgain\(\)/);
        assert.doesNotMatch(source, /vertical: true|_sync\(|Gio\.File/);
        assert.doesNotMatch(source, /[^\t\n -~]/);
    }
    assert.doesNotMatch(card, /gi:\/\/Gtk|gi:\/\/Adw|gi:\/\/Gdk/);
    assert.doesNotMatch(banner, /gi:\/\/St|org\/gnome\/shell\/ui/);
});
