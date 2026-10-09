import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_OAUTH_TOKEN_URL,
  LOAD_CODE_ASSIST_ENDPOINT,
  FETCH_AVAILABLE_MODELS_ENDPOINT,
} from '../../build/tests/antigravity-endpoints.mjs';
import {providerIconFile, providerMetadata} from '../../build/tests/provider-metadata.mjs';
import {
  extractModelQuotaBuckets,
  normalizeAntigravityUsage,
} from '../../build/tests/antigravity-normalize.mjs';

test('Antigravity metadata defines five-hour and weekly live quota windows', () => {
  const metadata = providerMetadata('antigravity');
  assert.equal(metadata.label, 'Antigravity');
  assert.equal(metadata.defaultAccent, 'cyan');
  assert.equal(metadata.defaultQuotaWindow, 'automatic');
  assert.deepEqual(metadata.quotaWindows, ['five-hour', 'weekly']);
  assert.equal(metadata.localHistorySupported, false);
  assert.equal(providerIconFile('antigravity'), 'antigravity-mono-light.svg');
  assert.equal(providerIconFile('antigravity', 'dark'), 'antigravity-mono-dark.svg');
});

test('Antigravity request endpoints point to official Google Cloud Code APIs', () => {
  assert.equal(GOOGLE_OAUTH_TOKEN_URL, 'https://oauth2.googleapis.com/token');
  assert.equal(LOAD_CODE_ASSIST_ENDPOINT, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.equal(FETCH_AVAILABLE_MODELS_ENDPOINT, 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
});

test('Antigravity model quota extraction parses remaining fractions and reset times', () => {
  const payload = {
    models: {
      'gemini-2.5-pro': {
        displayName: 'Gemini 2.5 Pro',
        quotaInfo: {
          remainingFraction: 0.85,
          resetTime: '2026-03-09T22:00:00Z',
        },
      },
      'claude-3-7-sonnet': {
        displayName: 'Claude 3.7 Sonnet',
        quotaInfo: {
          remainingFraction: 0.60,
          resetTime: '2026-03-16T12:00:00Z',
        },
      },
    },
  };

  const buckets = extractModelQuotaBuckets(payload);
  assert.equal(buckets.length, 2);

  const gemini = buckets.find(b => b.id === 'gemini-2.5-pro');
  assert.ok(gemini);
  assert.equal(gemini.displayName, 'Gemini 2.5 Pro');
  assert.equal(gemini.remainingFraction, 0.85);
  assert.equal(gemini.resetTime, '2026-03-09T22:00:00Z');

  const claude = buckets.find(b => b.id === 'claude-3-7-sonnet');
  assert.ok(claude);
  assert.equal(claude.displayName, 'Claude 3.7 Sonnet');
  assert.equal(claude.remainingFraction, 0.60);
});

test('Antigravity usage maps Gemini to five-hour and Claude/GPT to weekly canonical windows', () => {
  const codeAssistPayload = {
    currentTier: {
      id: 'free-tier',
      name: 'Antigravity Pro',
    },
  };

  const modelsPayload = {
    models: {
      'gemini-2.5-flash': {
        displayName: 'Gemini 2.5 Flash',
        quotaInfo: {
          remainingFraction: 0.75,
          resetTime: '2026-03-09T20:00:00Z',
        },
      },
      'claude-3-5-sonnet': {
        displayName: 'Claude 3.5 Sonnet',
        quotaInfo: {
          remainingFraction: 0.40,
          resetTime: '2026-03-15T00:00:00Z',
        },
      },
    },
  };

  const result = normalizeAntigravityUsage(codeAssistPayload, modelsPayload);
  assert.equal(result.plan, 'Antigravity Pro');
  assert.equal(result.windows.length, 2);

  const fiveHour = result.windows.find(w => w.canonicalWindow === 'five-hour');
  assert.ok(fiveHour);
  assert.match(fiveHour.label, /Gemini/);
  assert.equal(Math.round(fiveHour.percent * 100), 25);
  assert.equal(fiveHour.windowSeconds, 5 * 3600);
  assert.equal(fiveHour.resetAt, Date.parse('2026-03-09T20:00:00Z'));

  const weekly = result.windows.find(w => w.canonicalWindow === 'weekly');
  assert.ok(weekly);
  assert.match(weekly.label, /Claude/);
  assert.equal(Math.round(weekly.percent * 100), 60);
  assert.equal(weekly.windowSeconds, 7 * 86400);
  assert.equal(weekly.resetAt, Date.parse('2026-03-15T00:00:00Z'));
});

test('Antigravity normalization safely handles empty or unexpected payloads', () => {
  const emptyResult = normalizeAntigravityUsage(null, null);
  assert.equal(emptyResult.plan, 'Antigravity');
  assert.deepEqual(emptyResult.windows, []);

  const malformedResult = normalizeAntigravityUsage({}, {models: 'not-an-object'});
  assert.deepEqual(malformedResult.windows, []);
});
