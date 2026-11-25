import test from 'node:test';
import assert from 'node:assert/strict';
import {UNTRANSLATED} from '../../build/tests/i18n.mjs';
import {accountPace, paceLead, paceState, windowPace} from '../../build/tests/pace.mjs';

const HOUR = 3600 * 1000;
const now = Date.parse('2026-11-23T12:00:00Z');
// A five-hour window that is halfway through.
const window = (percent, extra = {}) => ({percent, resetAt: now + 2.5 * HOUR, durationSeconds: 5 * 3600, ...extra});
const clock = timestamp => new Date(timestamp).toISOString().slice(11, 16);

test('pace compares usage with the share of the window that has passed', () => {
    assert.equal(paceState(paceLead(window(0.8), now)), 'high');
    assert.equal(paceState(paceLead(window(0.55), now)), 'on-track');
    assert.equal(paceState(paceLead(window(0.45), now)), 'on-track');
    assert.equal(paceState(paceLead(window(0.2), now)), 'low');
});

test('a window without a reported length, or at its very start or end, has no pace', () => {
    assert.equal(paceLead(window(0.5, {durationSeconds: null}), now), null);
    assert.equal(paceLead(window(0.5, {resetAt: null}), now), null);
    assert.equal(paceLead(window(null), now), null);
    assert.equal(paceLead(window(0.5, {resetAt: now + 4.9 * HOUR}), now), null);
    assert.equal(paceLead(window(0.5, {resetAt: now - 1}), now), null);
});

test('a fast pace names the time the limit runs out', () => {
    // 80% used after 2.5 hours runs out after 3.125 hours, at 12:37.
    assert.deepEqual(windowPace(UNTRANSLATED, window(0.8), clock, now), {state: 'high', text: 'Fast pace: at this rate, it runs out around 12:37'});
    assert.deepEqual(windowPace(UNTRANSLATED, window(1), clock, now), {state: 'high', text: 'Fast pace: used up before the reset'});
    assert.equal(windowPace(UNTRANSLATED, window(0.5), clock, now).text, 'On pace for this period');
    assert.equal(windowPace(UNTRANSLATED, window(0.1), clock, now).state, 'low');
});

test('the top bar shows the pace of the most pressed limit', () => {
    assert.equal(accountPace([window(0.2), window(0.9)], now), 'high');
    assert.equal(accountPace([window(0.2), window(0.5)], now), 'on-track');
    assert.equal(accountPace([window(0.5, {durationSeconds: null})], now), null);
});
