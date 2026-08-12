import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationBucket,
  selectedNotificationWindow,
  shouldNotifyMilestone,
} from '../../build/tests/notification-policy.mjs';

const provider = preference => ({id: 'codex-personal', panelWindowPreference: preference});
const snapshot = {
  windows: [
    {id: 'five', canonicalWindow: 'five-hour', label: 'Five-hour', percent: 0.42},
    {id: 'week', canonicalWindow: 'weekly', label: 'Weekly', percent: 0.68},
  ],
};

test('only the provider-selected quota window drives notifications', () => {
  assert.equal(selectedNotificationWindow(provider('five-hour'), snapshot)?.canonicalWindow, 'five-hour');
  assert.equal(selectedNotificationWindow(provider('weekly'), snapshot)?.canonicalWindow, 'weekly');
  assert.equal(selectedNotificationWindow(provider('automatic'), snapshot)?.canonicalWindow, 'weekly');
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
