import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedProviders, reorderProviders} from '../../build/tests/provider-order.mjs';

const provider = (id, sortOrder, enabled = true) => ({id, sortOrder, enabled});

test('provider order is stable and includes disabled accounts', () => {
  const providers = [provider('late', 9), provider('first', 0, false), provider('also-first', 0)];
  assert.deepEqual(orderedProviders(providers).map(item => item.id), ['first', 'also-first', 'late']);
});

test('reordering normalizes sortOrder and safely appends omitted accounts', () => {
  const providers = [provider('a', 4), provider('b', 1, false), provider('c', 8)];
  const reordered = reorderProviders(providers, ['c', 'c', 'unknown', 'a']);
  assert.deepEqual(reordered.map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(reordered.map(item => item.sortOrder), [0, 1, 2]);
  assert.equal(reordered[2].enabled, false);
});
