import test from 'node:test';
import assert from 'node:assert/strict';
import {
    balanceNotificationText,
    clampStep,
    limitNotificationText,
    notificationBucket,
    checkMilestone,
    migrateNotificationState,
    nextCheckpoint,
    notificationKey,
    shouldNotifyLowBalance,
    shouldNotifyMilestone,
    parseTestNotificationRequest,
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

test('first observation seeds silently and later bucket crossing notifies once', () => {
    assert.equal(shouldNotifyMilestone(null, 'weekly:reset-1', 6, 10), false);
    const previous = {resetIdentity: 'weekly:reset-1', lastNotifiedBucket: 6, configuredStep: 10};
    assert.equal(shouldNotifyMilestone(previous, 'weekly:reset-1', 6, 10), false);
    assert.equal(shouldNotifyMilestone(previous, 'weekly:reset-1', 7, 10), true);
    assert.equal(shouldNotifyMilestone(previous, 'weekly:reset-2', 7, 10), false);
});

test('notification buckets are clamped and step-normalized', () => {
    assert.equal(clampStep(24), 25);
    assert.equal(clampStep(1), 5);
    assert.equal(clampStep(90), 50);
    assert.equal(notificationBucket(0.68, 10), 6);
    assert.equal(notificationBucket(1.2, 10), 10);
    assert.equal(notificationBucket(0.26, 24), 1);
});

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

test('each shown limit has its own state key', () => {
    assert.equal(notificationKey('a', {id: 'five_hour', canonicalWindow: 'five-hour'}), 'a:five-hour');
    assert.equal(notificationKey('a', {id: 'seven_day_opus', canonicalWindow: 'other'}), 'a:seven_day_opus');
});

test('test notifications use the first shown limit and its current reading', () => {
    const pinned = testNotificationText(tr, 'Codex', provider({automatic: false, limits: ['five-hour']}), snapshot, 'remaining', NOW);
    assert.deepEqual(pinned, {source: 'Codex - Personal', title: 'Five-hour: 58% left', body: 'Test notification - Reset time unknown'});
    assert.equal(testNotificationText(tr, 'Codex', provider(auto), snapshot, 'remaining', NOW).title, 'Weekly: 32% left');
});

test('test notifications without data preview the first limit of the service', () => {
    assert.equal(testNotificationText(tr, 'Kiro', provider(auto, 'kiro'), null, 'remaining', NOW).title, 'Monthly: 66% left');
});

test('test notification requests require only bounded provider and nonce strings', () => {
    assert.deepEqual(parseTestNotificationRequest('{"providerId":"account-1","nonce":"unique"}'), {providerId: 'account-1', nonce: 'unique'});
    for (const malformed of ['', '{}', '[]', '{"providerId":"account-1"}', '{"providerId":4,"nonce":"x"}', 'not json'])
        assert.equal(parseTestNotificationRequest(malformed), null);
});

test('0.3.x alert state is carried over to the per-limit keys', () => {
    const migrated = migrateNotificationState({
        'a:selected-limit': {providerId: 'a', resetIdentity: 'weekly:1794200000000', lastNotifiedBucket: 6, configuredStep: 10},
        'b:selected-limit': {providerId: 'b', resetIdentity: 'five-hour:unknown', lastNotifiedBucket: 2, configuredStep: 10},
        'c:monthly': {providerId: 'c', resetIdentity: 'monthly:1', lastNotifiedBucket: 1, configuredStep: 10},
    });
    assert.deepEqual(Object.keys(migrated).sort(), ['a:weekly', 'b:five-hour', 'c:monthly']);
    assert.equal(migrated['a:weekly'].lastNotifiedBucket, 6);
});

test('a low balance alerts once when it drops below the warning', () => {
    assert.equal(shouldNotifyLowBalance(null, true), false, 'the first reading only seeds');
    assert.equal(shouldNotifyLowBalance(false, true), true);
    assert.equal(shouldNotifyLowBalance(true, true), false);
    assert.equal(shouldNotifyLowBalance(true, false), false);
});

test('a limit without a reset time starts over when its reading falls', () => {
    const previous = {resetIdentity: 'other:unknown', lastNotifiedBucket: 8, configuredStep: 10};
    assert.equal(nextCheckpoint(previous, 'other:unknown', 2, 10, false).lastNotifiedBucket, 2, 'a top-up re-arms the alerts');
    assert.equal(nextCheckpoint(previous, 'other:unknown', 9, 10, false).lastNotifiedBucket, 9);
    const timed = {resetIdentity: 'weekly:1', lastNotifiedBucket: 8, configuredStep: 10};
    assert.equal(nextCheckpoint(timed, 'weekly:1', 2, 10, true).lastNotifiedBucket, 8, 'a timed limit waits for its reset');
    assert.equal(nextCheckpoint(timed, 'weekly:2', 2, 10, true).lastNotifiedBucket, 2);
});

test('each limit keeps its own milestones under a key that 0.3.x state migrates to', () => {
    const window = {id: 'seven_day', canonicalWindow: 'weekly', resetAt: 1794200000000, percent: 0.62};
    const seeded = checkMilestone(null, window, 10);
    assert.equal(seeded.notify, false);
    assert.deepEqual(seeded.checkpoint, {resetIdentity: 'weekly:1794199980000', lastNotifiedBucket: 6, configuredStep: 10});
    const crossed = checkMilestone(seeded.checkpoint, {...window, percent: 0.71}, 10);
    assert.equal(crossed.notify, true);
    assert.equal(crossed.consumed, 0.71);
    const legacy = {providerId: 'a', resetIdentity: 'weekly:1794200000000', lastNotifiedBucket: 6, configuredStep: 10};
    const migrated = migrateNotificationState({'a:selected-limit': legacy});
    assert.equal(notificationKey('a', window), 'a:weekly');
    assert.equal(checkMilestone(migrated['a:weekly'], window, 10).notify, false, 'the upgrade does not re-alert');
});

test('a reset time that drifts by milliseconds is the same reset', () => {
    const window = {id: 'five_hour', canonicalWindow: 'five-hour', resetAt: 1794271200177, percent: 0.82};
    const seeded = checkMilestone(null, window, 10);
    const next = checkMilestone(seeded.checkpoint, {...window, resetAt: 1794271199875, percent: 0.91}, 10);
    assert.equal(next.notify, true);
});

test('a damaged 0.3.x alert entry is dropped instead of stopping the start', () => {
    const migrated = migrateNotificationState({'a:selected-limit': {providerId: 'a', lastNotifiedBucket: 2, configuredStep: 10}});
    assert.deepEqual(migrated, {});
});
