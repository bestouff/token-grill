import test from 'node:test';
import assert from 'node:assert/strict';
import {UNTRANSLATED} from '../../build/tests/i18n.mjs';
import {activeProvider, displayLabel, displayPercent, limitName, mostUsedWindow, pressureClass} from '../../build/tests/display.mjs';

const windows = [
    {id: 'five', canonicalWindow: 'five-hour', label: 'Five-hour', percent: 0.42},
    {id: 'week', canonicalWindow: 'weekly', label: 'Weekly', percent: 0.68},
];

test('remaining mode is the inverse of consumed pressure', () => {
    const window = {percent: 0.68};
    assert.equal(Math.round(displayPercent(window, 'remaining') * 100), 32);
    assert.equal(Math.round(displayPercent(window, 'used') * 100), 68);
    assert.equal(displayLabel(UNTRANSLATED, window, 'remaining'), '32% left');
    assert.equal(displayLabel(UNTRANSLATED, window, 'used'), '68% used');
});

test('missing quota readings remain unavailable', () => {
    assert.equal(displayPercent(null, 'remaining'), null);
    assert.equal(displayPercent({percent: null}, 'used'), null);
    assert.equal(displayLabel(UNTRANSLATED, null, 'used'), '-');
});

test('window selection honours the preference, label patterns, then the most used window', () => {
    assert.equal(mostUsedWindow({windows}).id, 'week');
    assert.equal(mostUsedWindow(null), null);
});

test('pressure thresholds and active account fallback', () => {
    assert.equal(pressureClass({percent: 0.5}), 'neutral');
    assert.equal(pressureClass({percent: 0.8}), 'warning');
    assert.equal(pressureClass({percent: 0.95}), 'critical');
    const providers = [{id: 'a', enabled: false}, {id: 'b', enabled: true}, {id: 'c', enabled: true}];
    assert.equal(activeProvider(providers, 'a').id, 'b');
    assert.equal(activeProvider(providers, 'c').id, 'c');
});

test('the balance limit is named through the translator', () => {
    const tr = {_: text => `[${text}]`, ngettext: text => text};
    assert.equal(limitName(tr, {id: 'balance', canonicalWindow: 'other', label: 'Balance'}), '[Balance]');
    assert.equal(limitName(tr, {id: 'Spark:weekly', canonicalWindow: 'other', label: 'Spark - Weekly'}), 'Spark - Weekly');
});
