import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
    parseAccountChanged, parseAccounts, parseAlert, parseImportResult, parseSettings, parseState, ServiceSchemaError,
    statusForError,
} from '../../build/tests/service-state.mjs';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

// What callError builds: the message is stripped, the remote name is the code.
const remote = code => Object.assign(new Error('The name is not activatable'), {code});

test('a missing service is reported as missing', () => {
    assert.equal(statusForError(remote('org.freedesktop.DBus.Error.ServiceUnknown')), 'missing');
});

test('timeouts, NoReply, a vanished name and service errors are not responding', () => {
    for (const code of [
        'org.freedesktop.DBus.Error.NoReply',
        'org.freedesktop.DBus.Error.NameHasNoOwner',
        'org.freedesktop.DBus.Error.Disconnected',
        'ShuttingDown',
    ])
        assert.equal(statusForError(remote(code)), 'not-responding', code);
    assert.equal(statusForError(new Error('Timeout was reached')), 'not-responding');
    assert.equal(statusForError('text'), 'not-responding');
    assert.equal(statusForError(null), 'not-responding');
});

test('a payload the client cannot read is too old', () => {
    assert.equal(statusForError(new ServiceSchemaError('x')), 'too-old');
    assert.throws(() => parseState(JSON.stringify({schema: 2})), ServiceSchemaError);
});

const state = extra => JSON.stringify({
    schema: 1, apiVersion: 1, serviceVersion: '0.5.0', paused: false,
    settings: {refreshIntervalSeconds: 300, alertsEnabled: true, alertStepPercent: 10, journalDiagnostics: false},
    accounts: [], snapshots: {}, runtime: {}, ...extra,
});

test('parseState accepts schema 1 and rejects any other schema', () => {
    assert.equal(parseState(state()).serviceVersion, '0.5.0');
    for (const schema of [0, 2, '1', null, undefined])
        assert.throws(() => parseState(state({schema})), /schema/);
    assert.throws(() => parseState('not json'), ServiceSchemaError);
    assert.throws(() => parseState('[]'));
});

test('signal payloads are checked for schema 1', () => {
    assert.deepEqual(parseAccounts('{"schema":1,"accounts":[]}'), []);
    assert.throws(() => parseAccounts('{"schema":2,"accounts":[]}'), /schema/);
    assert.equal(parseSettings('{"schema":1,"settings":{"alertsEnabled":false}}').alertsEnabled, false);
    assert.throws(() => parseSettings('{"schema":3,"settings":{}}'), /schema/);
    assert.equal(parseAlert('{"schema":1,"kind":"test","accountId":"a"}').kind, 'test');
    assert.throws(() => parseAlert('{"kind":"test"}'), /schema/);
    const changed = parseAccountChanged('{"schema":1,"snapshot":{"providerId":"a"},"runtime":{"phase":"idle"}}');
    assert.equal(changed.snapshot.providerId, 'a');
    assert.equal(changed.runtime.phase, 'idle');
    assert.throws(() => parseAccountChanged('{"schema":2,"snapshot":{},"runtime":{}}'), /schema/);
});

test('an import counts as taken only when the service says it was not refused', () => {
    assert.deepEqual(parseImportResult('{"schema":1,"imported":2,"refused":false}'), {imported: 2, refused: false});
    assert.deepEqual(parseImportResult('{"schema":1,"imported":0,"refused":false}'), {imported: 0, refused: false});
    assert.deepEqual(parseImportResult('{"schema":1,"imported":0,"refused":true}'), {imported: 0, refused: true});
    // A reply without the flag cannot prove that the service holds the values.
    assert.deepEqual(parseImportResult('{"schema":1,"imported":0}'), {imported: 0, refused: true});
    assert.throws(() => parseImportResult('{"schema":2,"imported":1,"refused":false}'), /schema/);
});

const CLIENT = 'src/client.ts';

test('the proxy is made asynchronously and calls are asynchronous', async () => {
    const source = await read(CLIENT);
    assert.match(source, /Gio\.DBusProxy\.new_for_bus\(/);
    assert.doesNotMatch(source, /_sync\(/);
    assert.doesNotMatch(source, /DO_NOT_AUTO_START/);
    assert.match(source, /Gio\.DBusNodeInfo\.new_for_xml\(INTERFACE_XML\)/);
});

function destroyBody(source) {
    const start = source.indexOf('    destroy(): void {');
    assert.notEqual(start, -1, 'destroy() exists');
    return source.slice(start, source.indexOf('\n    }\n', start));
}

test('every signal connection is disconnected in destroy()', async () => {
    const source = await read(CLIENT);
    const connects = [...source.matchAll(/this\.(_\w+) = \w+\.connect\(/g)].map(match => match[1]);
    assert.deepEqual(connects.sort(), ['_ownerId', '_signalId']);
    assert.match(source, /connect\('g-signal'/);
    assert.match(destroyBody(source), /this\._dropProxy\(\)/);
    const drop = source.slice(source.indexOf('    private _dropProxy(): void {'));
    for (const field of connects)
        assert.match(drop, new RegExp(`this\\._proxy\\.disconnect\\(this\\.${field}\\)`), field);
});

test('the retry source is removed in destroy()', async () => {
    const source = await read(CLIENT);
    assert.match(source, /_retryId = GLib\.timeout_add_seconds\(GLib\.PRIORITY_DEFAULT, RETRY_SECONDS/);
    assert.match(source, /RETRY_SECONDS = 15/);
    assert.match(destroyBody(source), /GLib\.Source\.remove\(this\._retryId\)/);
    // The owner's cancellable is the only one: the client neither makes nor cancels its own (R-11).
    assert.match(source, /private readonly _cancellable: Gio\.Cancellable\n {4}\) \{\}/);
    assert.doesNotMatch(source, /new Gio\.Cancellable\(\)|_cancellable\.cancel\(\)/);
});

test('every continuation checks the cancellable and no lifecycle flag exists', async () => {
    const source = await read(CLIENT);
    assert.match(source, /_cancellable\.is_cancelled\(\)/);
    assert.doesNotMatch(source, /_(destroyed|connected|disposed|active)\s*[:=]\s*(true|false)/);
});

test('the client reports bugs to its logger, sends Goodbye without a callback and stops early when destroyed', async () => {
    const source = await read(CLIENT);
    assert.match(source, /_greeted\.call\('Goodbye', null, Gio\.DBusCallFlags\.NO_AUTO_START, -1, null, null\)/);
    assert.match(source, /this\._logger\.error\(/);
    assert.doesNotMatch(source, /\blogError\(/);
    assert.match(source, /async connect\(\): Promise<void> \{\s*if \(this\._cancellable\.is_cancelled\(\)\)\s*return;/);
    assert.match(source, /throw error;/);
    assert.match(destroyBody(source), /this\._dropProxy\(\)/);
});

test('Goodbye is owed from the moment Hello is sent', async () => {
    const source = await read(CLIENT);
    assert.ok(source.indexOf('this._greeted = proxy') < source.indexOf("this._invoke('Hello'"));
});
