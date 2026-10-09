import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {providerMetadata} from '../../build/tests/provider-metadata.mjs';

test('every provider declares an exact login command or none', () => {
  assert.equal(providerMetadata('codex').loginCommand, 'codex login');
  assert.equal(providerMetadata('claude').loginCommand, 'claude auth login');
  assert.equal(providerMetadata('kiro').loginCommand, 'kiro-cli login');
  assert.equal(providerMetadata('antigravity').loginCommand, null);
});

test('provider card wraps error text and offers a sign-in action for reauthentication', async () => {
  const source = await readFile(new URL('../../src/shell/providerCard.ts', import.meta.url), 'utf8');
  assert.match(source, /line_wrap = true/);
  assert.match(source, /_signInButton/);
  assert.match(source, /snapshot\.errorInfo\?\.message \|\| snapshot\.error/);
  assert.match(source, /_launchLogin/);
  const launch = source.slice(source.indexOf('_launchLogin()'));
  assert.match(launch, /GLib\.find_program_in_path/);
  assert.match(launch, /Gio\.Subprocess\.new/);
  assert.match(launch, /xdg-terminal-exec/);
});

test('login hints are derived from provider metadata, not hard-coded by kind', async () => {
  const source = await readFile(new URL('../../src/shell/providerCard.ts', import.meta.url), 'utf8');
  assert.match(source, /providerMetadata\(instance\.kind\)\.loginCommand/);
  assert.match(source, /providerMetadata\(kind\)\.loginCommand/);
  assert.doesNotMatch(source, /instance\.kind === 'kiro'/);
});