import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {firstProviderValidationError, validateProviderDraft} from '../../build/tests/provider-validation.mjs';

const home = '/home/test';
function canonicalize(value) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('A path is required.');
  const expanded = trimmed.startsWith('~/') ? `${home}/${trimmed.slice(2)}` : trimmed;
  if (!expanded.startsWith('/')) throw new Error('Paths must be absolute or start with ~/.');
  return path.posix.normalize(expanded);
}

const draft = overrides => ({
  id: 'new-provider',
  displayName: 'Codex',
  accountHome: '~/.codex',
  authFileOverride: null,
  sessionsDirectoryOverride: null,
  ...overrides,
});

test('a new provider with generated defaults and a unique home is valid', () => {
  const result = validateProviderDraft(draft(), [], canonicalize);
  assert.deepEqual(result, {valid: true, errors: {}});
  assert.equal(firstProviderValidationError(result), null);
});

test('an empty display name marks only the display-name field', () => {
  const result = validateProviderDraft(draft({displayName: '  '}), [], canonicalize);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, {displayName: 'Display name is required.'});
});

test('empty and relative account homes mark the account-home field', () => {
  for (const accountHome of ['', 'relative/account']) {
    const result = validateProviderDraft(draft({accountHome}), [], canonicalize);
    assert.equal(result.valid, false);
    assert.ok(result.errors.accountHome);
    assert.equal(result.errors.displayName, undefined);
  }
});

test('expanded equivalent account homes are duplicates', () => {
  const providers = [{id: 'existing', accountHome: '/home/test/.codex'}];
  const result = validateProviderDraft(draft({accountHome: '~/.codex'}), providers, canonicalize);
  assert.deepEqual(result.errors, {accountHome: 'Another provider already uses this account home.'});
});

test('editing a provider excludes its own account home', () => {
  const providers = [{id: 'existing', accountHome: '/home/test/.codex'}];
  const result = validateProviderDraft(draft({id: 'existing'}), providers, canonicalize);
  assert.deepEqual(result, {valid: true, errors: {}});
});

test('optional overrides identify their own invalid fields', () => {
  const result = validateProviderDraft(draft({
    authFileOverride: 'auth.json',
    sessionsDirectoryOverride: 'sessions',
  }), [], canonicalize);
  assert.deepEqual(result.errors, {
    authFileOverride: 'Paths must be absolute or start with ~/.',
    sessionsDirectoryOverride: 'Paths must be absolute or start with ~/.',
  });
});

test('correcting every invalid field clears stale errors', () => {
  const invalid = validateProviderDraft(draft({displayName: '', accountHome: 'relative'}), [], canonicalize);
  const corrected = validateProviderDraft(draft({displayName: 'Work', accountHome: '~/.codex-work'}), [], canonicalize);
  assert.equal(invalid.valid, false);
  assert.deepEqual(corrected, {valid: true, errors: {}});
});

test('credential and history locations do not need to exist', () => {
  const result = validateProviderDraft(draft({
    accountHome: '/does/not/exist',
    authFileOverride: '/does/not/exist/auth.json',
    sessionsDirectoryOverride: '/does/not/exist/sessions',
  }), [], canonicalize);
  assert.deepEqual(result, {valid: true, errors: {}});
});
