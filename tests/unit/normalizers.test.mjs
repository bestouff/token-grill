import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCodexUsage} from '../../build/tests/codex-normalize.mjs';
import {normalizeClaudeUsage} from '../../build/tests/claude-normalize.mjs';
import {normalizeKiroUsage} from '../../build/tests/kiro-normalize.mjs';

test('Codex weekly-only response is a valid weekly window', () => {
  const result = normalizeCodexUsage({plan_type: 'plus', rate_limit: {primary_window: {used_percent: 26, limit_window_seconds: 604800, reset_after_seconds: 535574, reset_at: 1786598031}}});
  assert.equal(result.plan, 'plus');
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].canonicalWindow, 'weekly');
  assert.equal(result.windows[0].percent, 0.26);
  assert.equal(result.windows[0].resetAt, 1786598031000);
});

test('Codex duration, rather than primary/secondary naming, identifies windows', () => {
  const result = normalizeCodexUsage({rate_limit: {primary_window: {used_percent: 40, limit_window_seconds: 18000}, secondary_window: {used_percent: 100, limit_window_seconds: 604800}}});
  assert.deepEqual(result.windows.map(window => window.canonicalWindow), ['five-hour', 'weekly']);
  assert.equal(result.windows[0].percent, 0.4);
  assert.equal(result.windows[1].percent, 1);
});

test('Codex percentage-point fields handle values at and below one percent', () => {
  const onePercent = normalizeCodexUsage({rate_limit: {primary_window: {used_percent: 1, limit_window_seconds: 604800}}});
  const fractionalPercent = normalizeCodexUsage({rate_limit: {primary_window: {used_percent: 0.4, limit_window_seconds: 604800}}});

  assert.equal(onePercent.windows[0].percent, 0.01);
  assert.equal(Math.round((1 - onePercent.windows[0].percent) * 100), 99);
  assert.equal(fractionalPercent.windows[0].percent, 0.004);
});

test('Codex computed ratios and percentage clamping remain safe', () => {
  const computed = normalizeCodexUsage({rate_limit: {primary_window: {used: 1, limit: 4, limit_window_seconds: 18000}}});
  const clamped = normalizeCodexUsage({rate_limit: {
    primary_window: {used_percent: -5, limit_window_seconds: 18000},
    secondary_window: {used_percent: 150, limit_window_seconds: 604800},
  }});

  assert.equal(computed.windows[0].percent, 0.25);
  assert.deepEqual(clamped.windows.map(window => window.percent), [0, 1]);
});

test('Claude OAuth usage maps canonical windows and ISO reset times', () => {
  const windows = normalizeClaudeUsage({five_hour: {utilization: 68, resets_at: '2026-08-07T12:00:00Z'}, seven_day: {utilization: 0.12, resets_at: '2026-08-13T12:00:00Z'}});
  assert.deepEqual(windows.map(window => window.canonicalWindow), ['five-hour', 'weekly']);
  assert.equal(windows[0].percent, 0.68);
  assert.equal(windows[1].percent, 0.12);
});

test('Kiro precision credit usage maps to a monthly window', () => {
  const result = normalizeKiroUsage({
    usageBreakdownList: [{resourceType: 'CREDIT', currentUsage: 0, currentUsageWithPrecision: 0.04, usageLimit: 2000, usageLimitWithPrecision: 2000, nextDateReset: 1788192000}],
    subscriptionInfo: {subscriptionTitle: 'KIRO PRO+', type: 'PRO_PLUS'},
  });
  assert.equal(result.plan, 'KIRO PRO+');
  assert.deepEqual(result.windows[0], {
    id: 'monthly-credits', canonicalWindow: 'monthly', label: 'Monthly credits', used: 0.04, limit: 2000,
    percent: 0.00002, resetAt: 1788192000000, resetAfterSeconds: null, windowSeconds: null, unit: 'credits',
  });
});

test('Kiro supports integer fields and response-level reset fallback', () => {
  const result = normalizeKiroUsage({usageBreakdownList: [{resourceType: 'CREDIT', currentUsage: 10, usageLimit: 100}], nextDateReset: 1788192000});
  assert.equal(result.windows[0].percent, 0.1);
  assert.equal(result.windows[0].resetAt, 1788192000000);
});

test('Kiro pooled quotas preserve credits without inventing a percentage', () => {
  const result = normalizeKiroUsage({usageBreakdownList: [{resourceType: 'CREDIT', currentUsageWithPrecision: 12.5, usageLimitWithPrecision: 0}]});
  assert.equal(result.windows[0].used, 12.5);
  assert.equal(result.windows[0].limit, 0);
  assert.equal(result.windows[0].percent, null);
});

test('Kiro clamps over-limit usage and rejects unusable shapes', () => {
  assert.equal(normalizeKiroUsage({usageBreakdownList: [{resourceType: 'CREDIT', currentUsage: 120, usageLimit: 100}]}).windows[0].percent, 1);
  assert.deepEqual(normalizeKiroUsage({usageBreakdownList: [{resourceType: 'TOKEN', foo: 1}]}).windows, []);
  assert.deepEqual(normalizeKiroUsage(null).windows, []);
});
