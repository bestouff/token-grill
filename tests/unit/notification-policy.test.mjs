import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationBucket,
  milestoneNotificationText,
  selectedNotificationWindow,
  shouldNotifyMilestone,
  parseTestNotificationRequest,
  testNotificationText,
  testNotificationWindowLabel,
} from '../../build/tests/notification-policy.mjs';
import {ACCENT_COLORS, accentColor} from '../../build/tests/accent.mjs';

const provider = preference => ({id: 'codex-personal', panelWindowPreference: preference});
const snapshot = {
  windows: [
    {id: 'five', canonicalWindow: 'five-hour', label: 'Five-hour', percent: 0.42},
    {id: 'week', canonicalWindow: 'weekly', label: 'Weekly', percent: 0.68},
    {id: 'month', canonicalWindow: 'monthly', label: 'Monthly', percent: 0.51},
  ],
};

test('only the provider-selected quota window drives notifications', () => {
  assert.equal(selectedNotificationWindow(provider('five-hour'), snapshot)?.canonicalWindow, 'five-hour');
  assert.equal(selectedNotificationWindow(provider('weekly'), snapshot)?.canonicalWindow, 'weekly');
  assert.equal(selectedNotificationWindow(provider('monthly'), snapshot)?.canonicalWindow, 'monthly');
  assert.equal(selectedNotificationWindow(provider('automatic'), snapshot)?.canonicalWindow, 'weekly');
  assert.equal(selectedNotificationWindow(provider('monthly'), {windows: snapshot.windows.slice(0, 2)})?.canonicalWindow, 'weekly');
});

test('first observation seeds silently and later bucket crossing notifies once', () => {
  assert.equal(shouldNotifyMilestone(null, 'weekly:reset-1', 6, 10), false);
  const previous = {resetIdentity: 'weekly:reset-1', lastNotifiedBucket: 6, configuredStep: 10};
  assert.equal(shouldNotifyMilestone(previous, 'weekly:reset-1', 6, 10), false);
  assert.equal(shouldNotifyMilestone(previous, 'weekly:reset-1', 7, 10), true);
  assert.equal(shouldNotifyMilestone(previous, 'weekly:reset-2', 7, 10), false);
});

test('notification buckets are clamped and step-normalized', () => {
  assert.equal(notificationBucket(0.68, 10), 6);
  assert.equal(notificationBucket(1.2, 10), 10);
  assert.equal(notificationBucket(0.26, 24), 1);
});

test('notification text follows display mode while milestones remain consumption-based', () => {
  const window = {label: 'Five-hour'};
  assert.deepEqual(milestoneNotificationText(window, 0.34, 30, 'remaining'), {
    title: 'Five-hour usage',
    body: '66% remaining · crossed the 30% milestone.',
  });
  assert.deepEqual(milestoneNotificationText(window, 0.34, 30, 'used'), {
    title: 'Five-hour usage',
    body: '34% consumed · crossed the 30% milestone.',
  });
  assert.deepEqual(milestoneNotificationText({label: 'Monthly credits'}, 0.51, 50, 'remaining'), {
    title: 'Monthly credits usage',
    body: '49% remaining · crossed the 50% milestone.',
  });
});

test('all account accents have stable notification emblem colors', () => {
  assert.deepEqual(Object.keys(ACCENT_COLORS).sort(), ['amber', 'blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red']);
  for (const [accent, color] of Object.entries(ACCENT_COLORS))
    assert.equal(accentColor({accent}), color);
});

test('test notifications use the selected or provider fallback window and requested display mode', () => {
  const configured = {...provider('five-hour'), kind: 'codex'};
  assert.equal(testNotificationWindowLabel(configured, snapshot), 'Five-hour');
  assert.equal(testNotificationWindowLabel({...configured, panelWindowPreference: 'monthly'}, {windows: snapshot.windows.slice(0, 2)}), 'Weekly');
  assert.equal(testNotificationWindowLabel({...configured, kind: 'kiro', panelWindowPreference: 'monthly'}, null), 'Monthly credits');
  assert.deepEqual(testNotificationText('Five-hour', 'remaining'), {
    title: 'Five-hour usage',
    body: 'Test alert · 66% remaining · 30% milestone preview.',
  });
  assert.match(testNotificationText('Weekly', 'used').body, /34% consumed/);
});

test('test notification requests require only bounded provider and nonce strings', () => {
  assert.deepEqual(parseTestNotificationRequest('{"providerId":"account-1","nonce":"unique"}'), {providerId: 'account-1', nonce: 'unique'});
  for (const malformed of ['', '{}', '[]', '{"providerId":"account-1"}', '{"providerId":4,"nonce":"x"}', 'not json'])
    assert.equal(parseTestNotificationRequest(malformed), null);
});
