import test from 'node:test';
import assert from 'node:assert/strict';
import {historyMetrics} from '../../build/tests/history-metrics.mjs';

const instance = (overrides = {}) => ({kind: 'codex', localHistoryEnabled: true, ...overrides});
const runtime = (phase = 'idle', historyPhase = 'idle') => ({refresh: {phase, localHistory: {phase: historyPhase}}});
const snapshot = (overrides = {}) => ({
  localHistoryUpdatedAt: 1,
  todayTotals: {total: 12400},
  monthTotals: {total: 42000},
  monthCost: 3.42,
  ...overrides,
});

test('history metrics distinguish unsupported, disabled, pending, updating, and initial failure', () => {
  assert.equal(historyMetrics(instance({kind: 'kiro'}), null, runtime()).today.value, 'Not supported');
  assert.equal(historyMetrics(instance({localHistoryEnabled: false}), null, runtime()).today.value, 'History off');
  assert.equal(historyMetrics(instance(), null, runtime()).today.value, 'Waiting…');
  assert.equal(historyMetrics(instance(), null, runtime('scanning-history')).today.value, 'Updating…');
  assert.equal(historyMetrics(instance(), null, runtime('failed', 'failed')).today.value, 'Scan failed');
});

test('successful history metrics show explicit token and currency units, including zero', () => {
  const populated = historyMetrics(instance(), snapshot(), runtime('success', 'success'));
  assert.deepEqual(populated.today, {value: '12.4K', unit: 'TOKENS'});
  assert.deepEqual(populated.month, {value: '42.0K', unit: 'TOKENS'});
  assert.deepEqual(populated.cost, {value: '$3.42', unit: 'USD'});

  const empty = historyMetrics(instance(), snapshot({todayTotals: {total: 0}, monthTotals: {total: 0}, monthCost: null}), runtime());
  assert.deepEqual(empty.today, {value: '0', unit: 'TOKENS'});
  assert.deepEqual(empty.cost, {value: '$0.00', unit: 'USD'});
});

test('unpriced history is precise and cached metrics survive later scan failure', () => {
  assert.deepEqual(historyMetrics(instance(), snapshot({monthCost: null}), runtime()).cost, {value: 'No price data', unit: ''});
  const cached = historyMetrics(instance(), snapshot(), runtime('failed', 'failed'));
  assert.equal(cached.month.value, '42.0K');
});
