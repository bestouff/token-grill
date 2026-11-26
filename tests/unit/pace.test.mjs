import test from 'node:test';
import assert from 'node:assert/strict';
import {UNTRANSLATED} from './untranslated.mjs';
import {paceLine} from '../../build/tests/pace.mjs';

const HOUR = 3600 * 1000;
const now = Date.parse('2026-11-23T12:00:00Z');
const clock = timestamp => new Date(timestamp).toISOString().slice(11, 16);

test('a fast pace names the time the limit runs out', () => {
    assert.deepEqual(paceLine(UNTRANSLATED, {state: 'high', runsOutAt: now + 0.625 * HOUR}, clock, now),
        {state: 'high', text: 'Fast pace: at this rate, it runs out around 12:37'});
    assert.deepEqual(paceLine(UNTRANSLATED, {state: 'high', runsOutAt: null}, clock, now),
        {state: 'high', text: 'Fast pace: used up before the reset'});
});

test('a run-out time that has passed since the service sent it reads as used up', () => {
    assert.equal(paceLine(UNTRANSLATED, {state: 'high', runsOutAt: now - 1}, clock, now).text, 'Fast pace: used up before the reset');
});

test('an even or a slow pace has its own line', () => {
    assert.deepEqual(paceLine(UNTRANSLATED, {state: 'on-track', runsOutAt: null}, clock, now), {state: 'on-track', text: 'On pace for this period'});
    assert.deepEqual(paceLine(UNTRANSLATED, {state: 'low', runsOutAt: null}, clock, now),
        {state: 'low', text: 'Slow pace: much of this limit will be left at the reset'});
});
