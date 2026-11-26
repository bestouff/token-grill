import test from 'node:test';
import assert from 'node:assert/strict';
import {UNTRANSLATED} from '../../build/tests/i18n.mjs';
import {isShown, topBarGroups, topBarSummary} from '../../build/tests/top-bar.mjs';

const window = (id, key, canonicalWindow, percent) => ({id, key, canonicalWindow, label: id, used: null, limit: null, percent, resetAt: null, unit: null, pace: null});
const weekly = window('seven_day', 'weekly', 'weekly', 0.88);
// The service sends the shown limits of each account.
const snapshot = (windows, shownLimits, extra = {}) => ({windows, shownLimits, balance: null, pace: null, ...extra});
const account = (id, kind, topBar, extra = {}) => ({id, kind, accent: 'blue', enabled: true, topBar, ...extra});
const auto = {automatic: true, limits: []};

test('an account shows the limits the service says it shows', () => {
    const snapshots = new Map([['a', snapshot([weekly], ['weekly'])], ['b', snapshot([weekly], [])]]);
    const groups = topBarGroups([
        account('a', 'claude', {automatic: false, limits: ['five-hour', 'weekly']}),
        account('b', 'claude', {automatic: false, limits: ['five-hour']}),
    ], snapshots);
    assert.deepEqual(groups[0].accounts.map(item => [item.id, item.limits.map(limit => limit.key), item.missing]), [
        ['a', ['weekly'], false],
        ['b', [], true],
    ]);
});

test('balance accounts are shown by the balance key', () => {
    const balance = {amount: 42.1, currency: 'CNY'};
    const groups = topBarGroups([account('d', 'deepseek', {automatic: false, limits: ['balance']}, {displayName: 'API', lowBalance: 50})], new Map([['d', snapshot([], [], {balance})]]));
    assert.deepEqual(groups[0].accounts[0], {id: 'd', name: 'API', accent: 'blue', limits: [], balance, low: true, missing: false, pace: null});
});

test('groups keep account order and skip hidden and disabled accounts', () => {
    const snapshots = new Map();
    const groups = topBarGroups([
        account('c1', 'codex', auto),
        account('k', 'kiro', auto),
        account('c2', 'codex', auto),
        account('c3', 'codex', {automatic: false, limits: []}),
        account('x', 'claude', auto, {enabled: false}),
    ], snapshots);
    assert.deepEqual(groups.map(group => [group.kind, group.accounts.map(item => item.id)]), [['codex', ['c1', 'c2']], ['kiro', ['k']]]);
});

test('the top-bar summary names the chosen limits', () => {
    assert.equal(topBarSummary(UNTRANSLATED, {automatic: true, limits: []}), 'Picked automatically');
    assert.equal(topBarSummary(UNTRANSLATED, {automatic: false, limits: []}), 'Not in the top bar');
    assert.equal(topBarSummary(UNTRANSLATED, {automatic: false, limits: ['five-hour', 'weekly']}), 'Five-hour, Weekly');
    assert.equal(topBarSummary(UNTRANSLATED, {automatic: false, limits: ['balance', 'seven_day_opus']}), 'Balance, seven day opus');
});

test('a DeepSeek account on Pick Automatically still warns of a low balance', () => {
    const balance = {amount: 3, currency: 'CNY'};
    const meter = window('balance', 'balance', 'other', 0.9);
    const groups = topBarGroups([account('d', 'deepseek', auto, {lowBalance: 10})], new Map([['d', snapshot([meter], ['balance'], {balance})]]));
    assert.equal(groups[0].accounts[0].low, true);
    assert.deepEqual(groups[0].accounts[0].balance, balance);
});

test('the top bar shows the account pace only when the account asks for it', () => {
    const paced = snapshot([weekly], ['weekly'], {pace: {state: 'high', runsOutAt: null}});
    const shown = topBarGroups([account('a', 'claude', auto, {showPace: true})], new Map([['a', paced]]));
    assert.equal(shown[0].accounts[0].pace, 'high');
    const hidden = topBarGroups([account('a', 'claude', auto, {showPace: false})], new Map([['a', paced]]));
    assert.equal(hidden[0].accounts[0].pace, null);
});

test('an account with no ticked limit is not in the top bar', () => {
    assert.equal(isShown({topBar: {automatic: false, limits: []}}), false);
    assert.equal(isShown({topBar: {automatic: false, limits: ['weekly']}}), true);
    assert.equal(isShown({topBar: auto}), true);
});
