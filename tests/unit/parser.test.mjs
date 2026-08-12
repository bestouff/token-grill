import test from 'node:test';
import assert from 'node:assert/strict';

function parseCodex(line) {
  if (!line.includes('token_count')) return null;
  const record = JSON.parse(line);
  if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') return null;
  return record.payload.info?.last_token_usage || null;
}

test('Codex token_count records are extracted without retaining content', () => {
  const line = JSON.stringify({type: 'event_msg', timestamp: '2026-08-07T00:00:00Z', payload: {type: 'token_count', info: {last_token_usage: {input_tokens: 10, output_tokens: 5, total_tokens: 15}}}});
  assert.deepEqual(parseCodex(line), {input_tokens: 10, output_tokens: 5, total_tokens: 15});
});

test('irrelevant records are ignored', () => {
  assert.equal(parseCodex(JSON.stringify({type: 'response_item', payload: {type: 'message', text: 'token_count'}})), null);
});

