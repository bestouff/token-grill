import test from 'node:test';
import assert from 'node:assert/strict';
import {importOnce, migrateOnce} from '../../build/tests/migration.mjs';

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

const TAKEN = {imported: 1, refused: false};

function fakeClient(accounts, reply = () => Promise.resolve(TAKEN)) {
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
    resolve(TAKEN);
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

test('the Shell empties the key that Preferences imported before', async () => {
    const settings = fakeSettings();
    const prefs = fakeClient([]);
    await importOnce(settings, prefs);
    assert.equal(prefs.calls.length, 1);
    assert.deepEqual(settings.writes, [], 'Preferences never empty the key');
    // The service now has the accounts and the backup of the same values, so it does not refuse.
    const shell = fakeClient([{id: 'a'}], () => Promise.resolve({imported: 0, refused: false}));
    await migrateOnce(settings, shell, LIVE);
    assert.equal(shell.calls.length, 1);
    assert.deepEqual(settings.writes, [['provider-instances-json', '[]']]);
});

test('Preferences import only while the service has no accounts and the key has some', async () => {
    const withAccounts = fakeClient([{id: 'a'}]);
    await importOnce(fakeSettings(), withAccounts);
    assert.equal(withAccounts.calls.length, 0);
    const emptyKey = fakeSettings({'provider-instances-json': '[]'});
    const fresh = fakeClient([]);
    await importOnce(emptyKey, fresh);
    assert.equal(fresh.calls.length, 0);
    const refused = fakeSettings();
    await importOnce(refused, fakeClient([], () => Promise.resolve({imported: 0, refused: true})));
    assert.deepEqual(refused.writes, []);
    await importOnce(fakeSettings(), {state: null, importAccounts: () => assert.fail('no import without a state')});
});

test('nothing is imported when the key is empty or there is no state', async () => {
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
        return Promise.resolve(TAKEN);
    });
    await migrateOnce(settings, client, {is_cancelled: () => cancelled});
    assert.equal(client.calls.length, 1);
    assert.deepEqual(settings.writes, []);
});

test('a refused import keeps the key', async () => {
    const settings = fakeSettings();
    const client = fakeClient([], () => Promise.resolve({imported: 0, refused: true}));
    await migrateOnce(settings, client, LIVE);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(settings.writes, []);
    assert.equal(settings.store['provider-instances-json'], LEGACY_JSON);
});

test('an import that takes nothing but is not refused empties the key', async () => {
    const settings = fakeSettings();
    const client = fakeClient([], () => Promise.resolve({imported: 0, refused: false}));
    await migrateOnce(settings, client, LIVE);
    assert.deepEqual(settings.writes, [['provider-instances-json', '[]']]);
});
