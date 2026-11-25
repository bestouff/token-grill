import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateOnce} from '../../build/tests/migration.mjs';

const LIVE = {is_cancelled: () => false};
const LEGACY_JSON = '[{"schemaVersion":1,"id":"a","kind":"codex","app":"codex-cli"}]';

function fakeSettings(values = {}) {
    const store = {
        'provider-instances-json': LEGACY_JSON,
        'configuration-version': 3,
        'active-provider-id': 'a',
        'refresh-interval-seconds': 600,
        'notifications-enabled': false,
        'notification-step-percent': 25,
        'diagnostics-journal': true,
        ...values,
    };
    const writes = [];
    const typed = (key, type) => {
        assert.equal(typeof store[key], type, `${key} is read as a ${type}`);
        return store[key];
    };
    return {
        store,
        writes,
        get_string: key => typed(key, 'string'),
        get_uint: key => typed(key, 'number'),
        get_boolean: key => typed(key, 'boolean'),
        set_string: (key, value) => {
            writes.push([key, value]);
            store[key] = value;
            return true;
        },
    };
}

function fakeClient(accounts, reply = () => Promise.resolve(1)) {
    const calls = [];
    return {
        calls,
        state: {accounts},
        importAccounts(legacy) {
            calls.push(legacy);
            return reply();
        },
    };
}

test('the 0.4 settings are handed over once with exactly the legacy fields', async () => {
    const settings = fakeSettings();
    const client = fakeClient([]);
    await migrateOnce(settings, client, LIVE);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0], {
        providerInstancesJson: LEGACY_JSON,
        configurationVersion: 3,
        activeProviderId: 'a',
        refreshIntervalSeconds: 600,
        notificationsEnabled: false,
        notificationStepPercent: 25,
        diagnosticsJournal: true,
    });
    assert.deepEqual(Object.keys(client.calls[0]).sort(), [
        'activeProviderId', 'configurationVersion', 'diagnosticsJournal', 'notificationStepPercent',
        'notificationsEnabled', 'providerInstancesJson', 'refreshIntervalSeconds',
    ]);
    assert.deepEqual(settings.writes, [['provider-instances-json', '[]']]);
});

test('the key is cleared only after the service has the accounts', async () => {
    let resolve;
    const settings = fakeSettings();
    const client = fakeClient([], () => new Promise(done => {
        resolve = done;
    }));
    const migration = migrateOnce(settings, client, LIVE);
    await Promise.resolve();
    assert.equal(client.calls.length, 1);
    assert.deepEqual(settings.writes, [], 'nothing is cleared while the call is in flight');
    resolve(1);
    await migration;
    assert.deepEqual(settings.writes, [['provider-instances-json', '[]']]);
});

test('a failed import leaves the key for the next connection', async () => {
    const settings = fakeSettings();
    const client = fakeClient([], () => Promise.reject(new Error('InvalidArgs')));
    await assert.rejects(migrateOnce(settings, client, LIVE), /InvalidArgs/);
    assert.deepEqual(settings.writes, []);
    assert.equal(settings.store['provider-instances-json'], LEGACY_JSON);
});

test('a second connection with accounts present does not import again', async () => {
    const settings = fakeSettings();
    const client = fakeClient([]);
    await migrateOnce(settings, client, LIVE);
    client.state = {accounts: [{id: 'a'}]};
    settings.store['provider-instances-json'] = LEGACY_JSON;
    await migrateOnce(settings, client, LIVE);
    assert.equal(client.calls.length, 1);
});

test('nothing is imported when the service has accounts, the key is empty, or there is no state', async () => {
    const withAccounts = fakeClient([{id: 'a'}]);
    await migrateOnce(fakeSettings(), withAccounts, LIVE);
    assert.equal(withAccounts.calls.length, 0);

    const emptyKey = fakeSettings({'provider-instances-json': '[]'});
    const fresh = fakeClient([]);
    await migrateOnce(emptyKey, fresh, LIVE);
    assert.equal(fresh.calls.length, 0);
    assert.deepEqual(emptyKey.writes, []);

    const disconnected = {calls: [], state: null, importAccounts: () => assert.fail('no import without a state')};
    await migrateOnce(fakeSettings(), disconnected, LIVE);
});

test('a reply that arrives after disable() leaves the key alone', async () => {
    const settings = fakeSettings();
    let cancelled = false;
    const client = fakeClient([], () => {
        cancelled = true;
        return Promise.resolve(1);
    });
    await migrateOnce(settings, client, {is_cancelled: () => cancelled});
    assert.equal(client.calls.length, 1);
    assert.deepEqual(settings.writes, []);
});
