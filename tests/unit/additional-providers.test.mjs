import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeDeepSeekBalance, normalizeKimiUsage, normalizeOpenCodeUsage} from '../../build/tests/additional-normalize.mjs';
import {apiKeyFromRecord, kimiAccountConfig} from '../../build/tests/additional-auth-records.mjs';
import {chooseWindow, resolveQuotaSelection, balanceLabel} from '../../build/tests/display.mjs';
import {snapshotFingerprint, quotaFingerprint} from '../../build/tests/snapshot-fingerprint.mjs';
import {validateProviderDraft} from '../../build/tests/provider-validation.mjs';
import {PROVIDER_METADATA, providerIconFile} from '../../build/tests/provider-metadata.mjs';

test('DeepSeek preserves prepaid balances, including zero and negative values, without inventing percentages', () => {
  const balances = normalizeDeepSeekBalance({is_available: false, balance_infos: [
    {currency: 'USD', total_balance: '0', granted_balance: '0', topped_up_balance: '0'},
    {currency: 'CNY', total_balance: '-0.125', granted_balance: '0', topped_up_balance: '-0.125'},
  ]});
  assert.equal(balances.length, 2);
  assert.equal(balances[0].available, 0);
  assert.equal(balances[1].available, -0.125);
  assert.match(balanceLabel({balances}), /USD 0/);
  assert.deepEqual(normalizeDeepSeekBalance({balance_infos: []}), []);
  assert.deepEqual(normalizeDeepSeekBalance({is_available: true, balance_infos: [{currency: 'USD', total_balance: 'NaN'}]}), []);
});

test('OpenCode percentages are percentage points, even below one percent', () => {
  const windows = normalizeOpenCodeUsage({usage: {
    rolling: {percent: 0.4, resetsAt: '2026-10-09T12:00:00Z'},
    weekly: {percent: 1}, monthly: {percent: 100},
  }});
  assert.deepEqual(windows.map(x => x.percent), [0.004, 0.01, 1]);
  assert.equal(windows[0].resetAt, Date.parse('2026-10-09T12:00:00Z'));
  assert.deepEqual(normalizeOpenCodeUsage({usage: {weekly: {percent: null}}}), []);
});

test('Kimi ratios remain fractions and both monthly quotas are retained', () => {
  const windows = normalizeKimiUsage({usages: {
    limit_5h: {used_ratio: 0.3, reset_time: '2026-10-09T12:00:00Z'},
    limit_7d: {used_ratio: '0.2'}, limit_month_total: {used_ratio: 0.4}, limit_month_code: {used_ratio: 0.8},
  }});
  assert.equal(windows.length, 4);
  assert.equal(windows[0].percent, 0.3);
  assert.equal(windows[1].percent, 0.2);
  assert.equal(chooseWindow({windows}, 'monthly').id, 'limit_month_code');
  assert.equal(resolveQuotaSelection({windows}, 'monthly').selected.id, 'limit_month_code');
  assert.deepEqual(normalizeKimiUsage({usages: {limit_5h: {used_ratio: 'invalid'}}}), []);
});

test('legacy Kimi remaining counts are converted to usage with their duration', () => {
  const windows = normalizeKimiUsage({usage: {limit: '100', remaining: '75'}, limits: [
    {window: {duration: 300, timeUnit: 'MINUTE'}, detail: {limit: 100, used: 80, resetTime: '2026-10-09T12:00:00Z'}},
  ]});
  assert.equal(windows[0].percent, 0.25);
  assert.equal(windows[1].canonicalWindow, 'five-hour');
  assert.equal(windows[1].percent, 0.8);
  assert.deepEqual(normalizeKimiUsage({usage: {limit: 0, used: 0}}), []);
});

test('OpenCode credentials are selected by service, never from an unrelated provider', () => {
  const payload = {openai: {type: 'api', key: 'wrong'}, opencode: {type: 'api', key: 'zen'}, deepseek: {type: 'api', key: 'deepseek'}};
  assert.equal(apiKeyFromRecord(payload, ['deepseek']), 'deepseek');
  assert.equal(apiKeyFromRecord(payload, ['opencode-go', 'opencode']), 'zen');
  assert.equal(apiKeyFromRecord(payload, ['kimi-for-coding']), null);
  assert.equal(apiKeyFromRecord({api_key: 'standalone'}, []), 'standalone');
});

test('Kimi honors regional credential references and rejects path traversal and untrusted endpoints', () => {
  const config = {providers: {'managed:kimi-code': {base_url: 'https://api.kimi.ai/coding/v1', oauth: {key: 'oauth/kimi-code-env-example'}}}};
  assert.equal(kimiAccountConfig(config).credentialName, 'kimi-code-env-example');
  assert.equal(kimiAccountConfig(config).baseUrl, 'https://api.kimi.ai/coding/v1');
  assert.throws(() => kimiAccountConfig({providers: {'managed:kimi-code': {oauth: {key: 'oauth/../../secret'}}}}));
  assert.throws(() => kimiAccountConfig({providers: {'managed:kimi-code': {base_url: 'https://untrusted.example/coding/v1'}}}));
});

test('different providers can share OpenCode auth storage but duplicate accounts are rejected', () => {
  const existing = [{id: 'one', kind: 'deepseek', accountHome: '/accounts/opencode'}];
  const draft = {id: 'two', kind: 'opencode', displayName: 'Zen', accountHome: '/accounts/opencode'};
  assert.equal(validateProviderDraft(draft, existing, x => x).valid, true);
  assert.equal(validateProviderDraft({...draft, kind: 'deepseek'}, existing, x => x).valid, false);
});

test('balance changes are detected without depending on refresh timestamps', () => {
  const first = {windows: [], balances: [{currency: 'USD', available: 5}]};
  const second = {...first, balances: [{currency: 'USD', available: 4}]};
  assert.notEqual(snapshotFingerprint(first), snapshotFingerprint(second));
  assert.notEqual(quotaFingerprint(first), quotaFingerprint(second));
  assert.equal(quotaFingerprint(first), quotaFingerprint({...first, quotaFetchedAt: 123}));
});

test('every provider packages monochrome LobeHub assets for both backgrounds', async () => {
  for (const kind of Object.keys(PROVIDER_METADATA)) for (const appearance of ['light', 'dark']) {
    const file = providerIconFile(kind, appearance);
    assert.match(file, /-mono-(light|dark)\.svg$/);
    const svg = await readFile(new URL(`../../resources/icons/providers/${file}`, import.meta.url), 'utf8');
    assert.ok(svg.includes(appearance === 'light' ? '#ffffff' : '#000000'));
    assert.doesNotMatch(svg, /currentColor/);
  }
});
