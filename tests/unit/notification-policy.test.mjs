import test from 'node:test';
import assert from 'node:assert/strict';
import {
    alertText,
    balanceNotificationText,
    limitNotificationText,
    testNotificationText,
} from '../../build/tests/notification-policy.mjs';
import {UNTRANSLATED} from '../../build/tests/i18n.mjs';

const tr = UNTRANSLATED;
const provider = (topBar, kind = 'codex') => ({id: 'codex-personal', kind, displayName: 'Personal', topBar});
const auto = {automatic: true, limits: []};
const NOW = Date.UTC(2026, 10, 10, 12, 0);
const DAY = 24 * 60 * 60 * 1000;
const snapshot = {
    windows: [
        {id: 'five', canonicalWindow: 'five-hour', label: 'Five-hour', percent: 0.42},
        {id: 'week', canonicalWindow: 'weekly', label: 'Weekly', percent: 0.68},
        {id: 'month', canonicalWindow: 'monthly', label: 'Monthly', percent: 0.51},
    ],
};

test('a limit alert reads service, account, limit and amount', () => {
    const weekly = {id: 'seven_day', canonicalWindow: 'weekly', label: 'Weekly', percent: 0.88, resetAt: NOW + 2 * DAY};
    assert.deepEqual(limitNotificationText(tr, 'Claude', {displayName: 'Main'}, weekly, 0.88, 'remaining', NOW), {
        source: 'Claude - Main',
        title: 'Weekly: 12% left',
        body: 'Resets in 2d 0h',
    });
    assert.equal(limitNotificationText(tr, 'Claude', {displayName: 'Main'}, weekly, 0.88, 'used', NOW).title, 'Weekly: 88% used');
});

test('model-specific limits use their label and unknown resets say so', () => {
    const opus = {id: 'seven_day_opus', canonicalWindow: 'other', label: 'Weekly - Opus', percent: 0.4, resetAt: null};
    const text = limitNotificationText(tr, 'Claude', {displayName: 'Main'}, opus, 0.4, 'remaining', NOW);
    assert.equal(text.title, 'Weekly - Opus: 60% left');
    assert.equal(text.body, 'Reset time unknown');
});

test('a balance alert reads service, account and amount left', () => {
    assert.deepEqual(balanceNotificationText(tr, 'DeepSeek', {displayName: 'API', lowBalance: 10}, {amount: 8.4, currency: 'USD'}), {
        source: 'DeepSeek - API',
        title: 'Balance: $8.40 left',
        body: 'Below your $10.00 warning',
    });
});

test('test notifications use the first shown limit and its current reading', () => {
    const pinned = testNotificationText(tr, 'Codex', provider({automatic: false, limits: ['five-hour']}), snapshot, 'remaining', NOW);
    assert.deepEqual(pinned, {source: 'Codex - Personal', title: 'Five-hour: 58% left', body: 'Test notification - Reset time unknown'});
    assert.equal(testNotificationText(tr, 'Codex', provider(auto), snapshot, 'remaining', NOW).title, 'Weekly: 32% left');
});

test('test notifications without data preview the first limit of the service', () => {
    assert.equal(testNotificationText(tr, 'Kiro', provider(auto, 'kiro'), null, 'remaining', NOW).title, 'Monthly: 66% left');
});

// The service says which alert is due; the extension writes its text in the user's language and mode.
test('an alert from the service gets the text of its kind', () => {
    const weekly = {id: 'seven_day', canonicalWindow: 'weekly', label: 'Weekly', percent: 0.88, resetAt: NOW + 2 * DAY};
    const base = {schema: 1, accountId: 'codex-personal', window: null, fraction: null, balance: null, lowBalance: null, at: NOW};
    const instance = provider(auto);
    assert.deepEqual(alertText(tr, {...base, kind: 'milestone', window: weekly, fraction: 0.88}, instance, null, 'used', NOW), {
        source: 'Codex - Personal',
        title: 'Weekly: 88% used',
        body: 'Resets in 2d 0h',
    });
    const deepseek = {...provider(auto, 'deepseek'), displayName: 'API', lowBalance: 5};
    assert.deepEqual(alertText(tr, {...base, kind: 'low-balance', balance: {amount: 8.4, currency: 'USD'}, lowBalance: 10}, deepseek, null, 'remaining', NOW), {
        source: 'DeepSeek - API',
        title: 'Balance: $8.40 left',
        body: 'Below your $10.00 warning',
    }, 'the warning is the one the service compared against');
    assert.deepEqual(alertText(tr, {...base, kind: 'test'}, instance, snapshot, 'remaining', NOW),
        testNotificationText(tr, 'Codex', instance, snapshot, 'remaining', NOW));
});

test('an alert without the reading its kind needs shows nothing', () => {
    const base = {schema: 1, accountId: 'a', window: null, fraction: null, balance: null, lowBalance: null, at: NOW};
    assert.equal(alertText(tr, {...base, kind: 'milestone'}, provider(auto), null, 'remaining', NOW), null);
    assert.equal(alertText(tr, {...base, kind: 'low-balance'}, provider(auto, 'deepseek'), null, 'remaining', NOW), null);
    assert.equal(alertText(tr, {...base, kind: 'future-kind'}, provider(auto), null, 'remaining', NOW), null);
});
