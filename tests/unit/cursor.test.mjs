import test from 'node:test';
import assert from 'node:assert/strict';
import {isJwtLike, normalizeCursorPlan, normalizeCursorUsage} from '../../build/tests/cursor-normalize.mjs';

// The keys of a real GetCurrentPeriodUsage response (Free plan, 2026-11-18); the numbers are changed.
const usage = {
    billingCycleStart: '1792758535685',
    billingCycleEnd: '1795436935685',
    planUsage: {
        remainingBonus: false,
        bonusTooltip: 'text',
        autoPercentUsed: 40,
        apiPercentUsed: 12.5,
        totalPercentUsed: 30,
    },
    spendLimitUsage: {pooledLimit: '0', pooledRemaining: '0', individualLimit: 0, limitType: 'user', overallLimit: 0, overallRemaining: 0},
    displayThreshold: 200,
    displayMessage: "You've used 30% of your included usage",
    autoBucketModels: ['model-a', 'model-b'],
};

test('the total and both pools reset at the end of the monthly billing cycle', () => {
    const windows = normalizeCursorUsage(usage);
    assert.deepEqual(windows.map(window => [window.id, window.canonicalWindow, window.label, window.percent, window.resetAt]), [
        ['total', 'monthly', 'Monthly', 0.3, 1795436935685],
        ['cursor-models', 'other', 'Cursor Models · Monthly', 0.4, 1795436935685],
        ['other-models', 'other', 'Other Models · Monthly', 0.125, 1795436935685],
    ]);
});

test('a weekly cycle makes weekly limits', () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    const [total] = normalizeCursorUsage({...usage, billingCycleEnd: String(1792758535685 + week)});
    assert.equal(total.canonicalWindow, 'weekly');
});

test('percentages are clamped and missing pools are left out', () => {
    const windows = normalizeCursorUsage({...usage, planUsage: {totalPercentUsed: 140}});
    assert.deepEqual(windows.map(window => [window.id, window.percent]), [['total', 1]]);
});

test('responses without plan usage give no limits', () => {
    assert.deepEqual(normalizeCursorUsage({}), []);
    assert.deepEqual(normalizeCursorUsage(null), []);
    assert.deepEqual(normalizeCursorUsage({planUsage: {remainingBonus: false}}), []);
});

test('the plan name comes from GetPlanInfo', () => {
    assert.equal(normalizeCursorPlan({planInfo: {planName: 'Free', price: 'Free', billingCycleEnd: '1795436935685'}}), 'Free');
    assert.equal(normalizeCursorPlan({}), null);
});


test('only a plain JWT counts as a readable sign-in', () => {
    assert.equal(isJwtLike('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'), true);
    // The prefix that encrypted Cursor sign-ins carry.
    assert.equal(isJwtLike('cursor-safe-storage:v1:djExAAAA'), false);
    assert.equal(isJwtLike('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0'), false);
    assert.equal(isJwtLike(''), false);
});


test('the billing cycle gives the length of every pool, for usage pace', () => {
    const [total] = normalizeCursorUsage(usage);
    assert.equal(total.durationSeconds, (1795436935685 - 1792758535685) / 1000);
    const [unknown] = normalizeCursorUsage({...usage, billingCycleStart: undefined});
    assert.equal(unknown.durationSeconds, null);
});
