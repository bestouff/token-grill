import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the shipped interface text is the service interface file', async () => {
    const [source, xml] = await Promise.all([
        read('src/dbus/interface.ts'),
        read('service/src/tokengrill/dbus/interface.xml'),
    ]);
    const match = source.match(/export const INTERFACE_XML = `([^`]*)`;/);
    assert.ok(match, 'INTERFACE_XML is a plain template literal');
    assert.equal(match[1], xml);
    assert.doesNotMatch(match[1], /\$\{/);
});

test('the names match the service', async () => {
    const source = await read('src/dbus/interface.ts');
    assert.match(source, /SERVICE_NAME = 'io\.github\.sh02sahil\.TokenGrill'/);
    assert.match(source, /OBJECT_PATH = '\/io\/github\/sh02sahil\/TokenGrill'/);
    assert.match(source, /INTERFACE_NAME = 'io\.github\.sh02sahil\.TokenGrill1'/);
    assert.match(source, /MIN_API_VERSION = 1/);
});
