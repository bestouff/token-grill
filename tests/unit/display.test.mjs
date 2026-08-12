import test from 'node:test';
import assert from 'node:assert/strict';

function displayPercent(window, mode) {
  if (!window || window.percent === null) return null;
  return mode === 'remaining' ? 1 - window.percent : window.percent;
}

test('remaining mode is the inverse of consumed pressure', () => {
  const window = {percent: 0.68};
  assert.equal(Math.round(displayPercent(window, 'remaining') * 100), 32);
  assert.equal(Math.round(displayPercent(window, 'used') * 100), 68);
});

test('missing quota readings remain unavailable', () => {
  assert.equal(displayPercent(null, 'remaining'), null);
  assert.equal(displayPercent({percent: null}, 'used'), null);
});
