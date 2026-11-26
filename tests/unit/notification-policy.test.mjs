import test from 'node:test';
import assert from 'node:assert/strict';
import {alertText} from '../../build/tests/notification-policy.mjs';
import {UNTRANSLATED} from './untranslated.mjs';

const tr = UNTRANSLATED;
const provider = (kind = 'codex', extra = {}) => ({id: 'codex-personal', kind, displayName: 'Personal', ...extra});
const NOW = Date.UTC(2026, 10, 10, 12, 0);
const DAY = 24 * 60 * 60 * 1000;
// The service sends the windows in popup order with the keys of the limits the top bar shows.
const reading = shownLimits => ({
    windows: [
        {id: 'five', key: 'five-hour', canonicalWindow: 'five-hour', label: 'Five-hour', percent: 0.42},
        {id: 'week', key: 'weekly', canonicalWindow: 'weekly', label: 'Weekly', percent: 0.68},
        {id: 'month', key: 'monthly', canonicalWindow: 'monthly', label: 'Monthly', percent: 0.51},
    ],
    shownLimits,
});
const base = {schema: 1, accountId: 'codex-personal', window: null, fraction: null, balance: null, lowBalance: null, at: NOW};
const milestone = (window, fraction) => ({...base, kind: 'milestone', window, fraction});
const testAlert = {...base, kind: 'test'};

// The service says which alert is due; the extension writes its text in the user's language and mode.
test('a limit alert reads service, account, limit and amount', () => {
    const weekly = {id: 'seven_day', canonicalWindow: 'weekly', label: 'Weekly', percent: 0.88, resetAt: NOW + 2 * DAY};
    const claude = provider('claude', {displayName: 'Main'});
    assert.deepEqual(alertText(tr, milestone(weekly, 0.88), claude, null, 'remaining', NOW), {
        source: 'Claude - Main',
        title: 'Weekly: 12% left',
        body: 'Resets in 2d 0h',
    });
    assert.equal(alertText(tr, milestone(weekly, 0.88), claude, null, 'used', NOW).title, 'Weekly: 88% used');
});

test('model-specific limits use their label and unknown resets say so', () => {
    const opus = {id: 'seven_day_opus', canonicalWindow: 'other', label: 'Weekly - Opus', percent: 0.4, resetAt: null};
    const text = alertText(tr, milestone(opus, 0.4), provider('claude', {displayName: 'Main'}), null, 'remaining', NOW);
    assert.equal(text.title, 'Weekly - Opus: 60% left');
    assert.equal(text.body, 'Reset time unknown');
});

test('a balance alert reads service, account and the amount the service compared against', () => {
    const deepseek = provider('deepseek', {displayName: 'API', lowBalance: 5});
    const alert = {...base, kind: 'low-balance', balance: {amount: 8.4, currency: 'USD'}, lowBalance: 10};
    assert.deepEqual(alertText(tr, alert, deepseek, null, 'remaining', NOW), {
        source: 'DeepSeek - API',
        title: 'Balance: $8.40 left',
        body: 'Below your $10.00 warning',
    });
});

test('test notifications use the first shown limit and its current reading', () => {
    assert.deepEqual(alertText(tr, testAlert, provider(), reading(['five-hour']), 'remaining', NOW),
        {source: 'Codex - Personal', title: 'Five-hour: 58% left', body: 'Test notification - Reset time unknown'});
    assert.equal(alertText(tr, testAlert, provider(), reading(['weekly']), 'remaining', NOW).title, 'Weekly: 32% left');
    assert.equal(alertText(tr, testAlert, provider(), reading([]), 'remaining', NOW).title, 'Five-hour: 58% left');
});

test('test notifications without data preview the first limit of the service', () => {
    assert.equal(alertText(tr, testAlert, provider('kiro'), null, 'remaining', NOW).title, 'Monthly: 66% left');
});

test('an alert without the reading its kind needs shows nothing', () => {
    assert.equal(alertText(tr, {...base, kind: 'milestone'}, provider(), null, 'remaining', NOW), null);
    assert.equal(alertText(tr, {...base, kind: 'low-balance'}, provider('deepseek'), null, 'remaining', NOW), null);
    assert.equal(alertText(tr, {...base, kind: 'future-kind'}, provider(), null, 'remaining', NOW), null);
});
