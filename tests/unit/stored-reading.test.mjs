import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStoredReading, restoredSnapshot, storedReading} from '../../build/tests/stored-reading.mjs';

const window = {id: 'weekly', canonicalWindow: 'weekly', label: 'Weekly', used: null, limit: null, percent: 0.4, resetAt: 1795000000000, durationSeconds: null, unit: null};
const snapshot = {
    providerId: 'a', state: 'ready', lastUpdated: 1794000000000, error: null, errorInfo: null,
    plan: 'Pro', account: 'person@example.com', windows: [window], balance: null,
    quotaFetchedAt: 1794000000000, resetCredits: null,
};

test('a stored reading keeps the limits and leaves out the e-mail address', () => {
    const reading = storedReading(snapshot);
    assert.deepEqual(reading, {plan: 'Pro', windows: [window], balance: null, resetCredits: null, fetchedAt: 1794000000000});
    assert.doesNotMatch(JSON.stringify(reading), /example\.com/);
    assert.equal(storedReading({...snapshot, quotaFetchedAt: null}), null);
});

test('a stored reading round-trips and comes back stale with its age', () => {
    const reading = parseStoredReading(JSON.parse(JSON.stringify(storedReading(snapshot))));
    const restored = restoredSnapshot('a', reading);
    assert.equal(restored.state, 'stale');
    assert.equal(restored.quotaFetchedAt, 1794000000000);
    assert.deepEqual(restored.windows, [window]);
    assert.equal(restored.account, null);
});

test('a damaged entry is dropped as a whole', () => {
    const reading = storedReading(snapshot);
    assert.equal(parseStoredReading(null), null);
    assert.equal(parseStoredReading({...reading, fetchedAt: 'yesterday'}), null);
    assert.equal(parseStoredReading({...reading, windows: [{...window, percent: '40'}]}), null);
    assert.equal(parseStoredReading({...reading, windows: [{...window, canonicalWindow: 'daily'}]}), null);
    assert.equal(parseStoredReading({...reading, balance: {amount: 'x', currency: 'USD'}}), null);
});
