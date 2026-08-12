import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeResetCredits} from '../../build/tests/reset-credits-normalize.mjs';
import {durationUntil, formatResetDuration} from '../../build/tests/time-math.mjs';

test('reset credits preserve authoritative count and earliest expiry', () => {
  const result = normalizeResetCredits({
    available_count: 4,
    credits: [
      {status: 'available', title: 'Full reset', expires_at: 1784246400},
      {status: 'redeemed', title: 'Used', expires_at: 1781000000},
      {status: 'available', title: 'Referral', expires_at: 1783000000},
    ],
  }, 1000);
  assert.equal(result.availableCount, 4);
  assert.equal(result.credits.length, 2);
  assert.equal(result.nextExpiresAt, 1783000000000);
});

test('reset credits preserve a zero authoritative count without inventing rows', () => {
  const result = normalizeResetCredits({available_count: 0, total_earned_count: 3, credits: []}, 1000);
  assert.equal(result.availableCount, 0);
  assert.equal(result.totalEarnedCount, 3);
  assert.deepEqual(result.credits, []);
  assert.equal(result.nextExpiresAt, null);
});

test('reset countdown uses days only when needed', () => {
  assert.equal(formatResetDuration(durationUntil(6 * 86400000 + 4 * 3600000 + 3 * 60000, 0)), '6d 4h 3m');
  assert.equal(formatResetDuration(durationUntil(2 * 86400000 + 14 * 60000, 0)), '2d 0h 14m');
  assert.equal(formatResetDuration(durationUntil(4 * 3600000 + 12 * 60000, 0)), '4h 12m');
  assert.equal(formatResetDuration(durationUntil(8 * 60000, 0)), '8m');
  assert.equal(formatResetDuration(durationUntil(30 * 1000, 0)), 'less than 1m');
});
