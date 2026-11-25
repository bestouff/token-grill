import test from 'node:test';
import assert from 'node:assert/strict';
import {accountLabel, formatReport, redact, requestDetail, shapeOf} from '../../build/tests/diagnostics.mjs';

test('shapes never contain values', () => {
    const shape = shapeOf({access_token: 'sk-abc123secretvalue', usage: {rolling: {percent: 41, status: 'ok'}}, items: [1, 2, 3], ok: true, none: null});
    assert.equal(shape, '{access_token: string, usage: {rolling: {percent: number, status: string}}, items: [3 items], ok: boolean, none: null}');
    assert.doesNotMatch(shape, /sk-abc|41|ok'/);
});

test('shapes stop at three levels and six keys', () => {
    assert.equal(shapeOf({a: {b: {c: {d: 1}}}}), '{a: {b: {c: {...}}}}');
    assert.equal(shapeOf({a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1}), '{a: number, b: number, c: number, d: number, e: number, f: number, ...2 more}');
});

test('redaction removes tokens, e-mails, UUIDs and the home path', () => {
    const text = 'read /home/test/.codex/auth.json for jane.doe@example.com id 3f2a9c1e-1b2c-4d5e-8f90-1234567890ab token eyJhbGciOiJIUzI1NiJ9.e30.sig4567890 gho_A1b2C3d4E5f6G7h8I9j0K1l2M3';
    assert.equal(redact(text, '/home/test'), 'read ~/.codex/auth.json for <email> id <id> token <token> <token>');
});

test('long field names are not mistaken for tokens', () => {
    assert.equal(redact('{cloud_session_storage_enabled: boolean}', '/home/test'), '{cloud_session_storage_enabled: boolean}');
});

test('reports name accounts by service and number', () => {
    assert.equal(accountLabel('copilot', 1), 'copilot-1');
    const report = formatReport([
        {at: Date.UTC(2026, 10, 10, 9, 30), account: 'copilot-1', kind: 'copilot', app: 'github-cli', step: 'response', detail: 'HTTP 200 {quota_snapshots: {...}}'},
    ], {version: '0.4.0 alpha.1', shell: '50.1', date: '2026-11-10'});
    assert.equal(report, 'Token Grill 0.4.0 alpha.1 - GNOME Shell 50.1 - 2026-11-10\n2026-11-10T09:30:00.000Z copilot-1 (copilot, github-cli) response: HTTP 200 {quota_snapshots: {...}}\n');
});

test('a request is recorded as its method, host and path, never the query', () => {
    assert.equal(requestDetail('GET', 'https://api.deepseek.com/user/balance?key=sk-abc123'), 'GET api.deepseek.com/user/balance');
    assert.equal(requestDetail('POST', 'https://oidc.us-east-1.amazonaws.com/token'), 'POST oidc.us-east-1.amazonaws.com/token');
});

test('service host names stay readable', () => {
    assert.equal(redact('POST codewhisperer.us-east-1.amazonaws.com/ and oidc.eu-west-1.amazonaws.com/token', '/home/test'),
        'POST codewhisperer.us-east-1.amazonaws.com/ and oidc.eu-west-1.amazonaws.com/token');
});
