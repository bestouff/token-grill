import test from 'node:test';
import assert from 'node:assert/strict';

function normalize(value) {
  if (!value || typeof value !== 'object' || ![1, 2].includes(value.schemaVersion) || !['codex', 'claude', 'kiro'].includes(value.kind)) return null;
  return {...value, displayName: typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : value.kind};
}

test('independent Codex homes remain independent provider instances', () => {
  const personal = normalize({schemaVersion: 1, id: 'a', kind: 'codex', displayName: 'Personal', accountHome: '~/.codex'});
  const second = normalize({schemaVersion: 1, id: 'b', kind: 'codex', displayName: 'Proism', accountHome: '~/.codex2'});
  assert.equal(personal.id, 'a');
  assert.equal(second.id, 'b');
  assert.notEqual(personal.accountHome, second.accountHome);
});

test('invalid provider types are rejected', () => {
  assert.equal(normalize({schemaVersion: 1, id: 'x', kind: 'cursor'}), null);
});

test('Kiro provider definitions round-trip without a schema migration', () => {
  const kiro = normalize({schemaVersion: 2, id: 'k', kind: 'kiro', displayName: 'Kiro', accountHome: '/home/test/.local/share/kiro-cli', panelWindowPreference: 'monthly', localHistoryEnabled: false});
  assert.equal(kiro.kind, 'kiro');
  assert.equal(kiro.panelWindowPreference, 'monthly');
  assert.equal(kiro.localHistoryEnabled, false);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(kiro))), kiro);
});
