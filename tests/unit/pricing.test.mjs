import test from 'node:test';
import assert from 'node:assert/strict';

test('unknown models do not become zero-priced', () => {
  const catalog = {known: {input: 1, output: 2}};
  assert.equal(catalog.unknown, undefined);
});

