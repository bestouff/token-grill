import test from 'node:test';
import assert from 'node:assert/strict';
import {kimiApiHost, normalizeKimiUsage} from '../../build/tests/kimi-normalize.mjs';
import {matchOpenCodeEntry} from '../../build/tests/opencode-entries.mjs';

// Publicly described shape: a weekly `usage` block plus `limits`, numbers as strings.
const described = {
    usage: {limit: '1000', used: '250', remaining: '750', resetTime: '2026-11-16T00:00:00Z'},
    limits: [
        {window: {duration: 300, timeUnit: 'MINUTE'}, detail: {limit: '100', remaining: '60', resetTime: '2026-11-10T05:00:00Z'}},
        {name: 'Daily', window: {duration: 1, timeUnit: 'DAY'}, detail: {limit: '50', used: '5'}},
    ],
};

test('the described usage and limits become five-hour, weekly and other limits', () => {
    const windows = normalizeKimiUsage(described);
    assert.deepEqual(windows.map(window => [window.canonicalWindow, window.label, window.percent, window.resetAt]), [
        ['weekly', 'Weekly', 0.25, Date.parse('2026-11-16T00:00:00Z')],
        ['five-hour', 'Five-hour', 0.4, Date.parse('2026-11-10T05:00:00Z')],
        ['other', 'Daily', 0.1, null],
    ]);
});

test('the ratio layout parses too', () => {
    const windows = normalizeKimiUsage({
        usages: {
            limit_5h: {used_ratio: 0.3, reset_time: '2026-11-10T05:00:00Z'},
            limit_7d: {used_ratio: 0.5},
            limit_month_total: {used_ratio: '0.7'},
        },
    });
    assert.deepEqual(windows.map(window => [window.canonicalWindow, window.percent]), [['five-hour', 0.3], ['weekly', 0.5], ['monthly', 0.7]]);
});

test('unusable responses give no limits', () => {
    assert.deepEqual(normalizeKimiUsage({}), []);
    assert.deepEqual(normalizeKimiUsage({usage: {limit: '0', used: '0'}}), []);
});

test('the global host is the default, the .ai host only when configured', () => {
    assert.equal(kimiApiHost(''), 'api.kimi.com');
    assert.equal(kimiApiHost('[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\n'), 'api.kimi.ai');
});

test('a Kimi Code key in OpenCode belongs to Kimi Code', () => {
    assert.deepEqual(matchOpenCodeEntry('kimi-for-coding', {type: 'api', key: 'k'}), {status: 'service', kind: 'kimi'});
});

test('a second Kimi window of the same type stays a limit of its own', () => {
    const limit = (name, duration, timeUnit) => ({name, window: {duration, timeUnit}, detail: {limit: 100, used: 10}});
    const windows = normalizeKimiUsage({limits: [limit('Chat', 300, 'MINUTE'), limit('Agent', 5, 'HOUR')]});
    assert.deepEqual(windows.map(item => [item.canonicalWindow, item.label]), [['five-hour', 'Five-hour'], ['other', 'Agent · Five-hour']]);
});


test('window lengths come from the reported duration or the key names', () => {
    const windows = normalizeKimiUsage(described);
    assert.deepEqual(windows.map(window => window.durationSeconds), [null, 5 * 3600, 86400]);
    const ratio = normalizeKimiUsage({
        usages: {
            limit_5h: {used_ratio: 0.3},
            limit_7d: {used_ratio: 0.3},
            limit_month_total: {used_ratio: 0.3, reset_time: '2026-12-01T00:00:00Z'},
        },
    });
    assert.deepEqual(ratio.map(window => window.durationSeconds), [5 * 3600, 7 * 86400, 30 * 86400]);
});
