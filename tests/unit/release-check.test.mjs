import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

async function makeRoot(t, extra = {}, track = []) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tokengrill-release-check-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const metadata = await readFile(new URL('../../metadata.json', import.meta.url), 'utf8');
    const dist = `dist/${JSON.parse(metadata).uuid}`;
    const files = {
        'metadata.json': metadata,
        'package.json': await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
        'deleted.md': '',
        'docs/screenshots/panel-indicator.png': Buffer.alloc(10_000),
        'docs/screenshots/usage-dashboard.png': Buffer.alloc(10_000),
        [`${dist}/metadata.json`]: metadata,
        [`${dist}/extension.js`]: '',
        [`${dist}/prefs.js`]: '',
        [`${dist}/schemas/org.gnome.shell.extensions.tokengrill.gschema.xml`]: '',
        ...extra,
    };
    await mkdir(path.join(root, 'src'));
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(root, name);
        await mkdir(path.dirname(file), {recursive: true});
        await writeFile(file, content);
    }
    execFileSync('git', ['init', '--quiet'], {cwd: root});
    execFileSync('git', ['add', 'deleted.md', ...track], {cwd: root});
    await rm(path.join(root, 'deleted.md'));
    return root;
}

function runChecker(root) {
    const checker = fileURLToPath(new URL('../../tools/release-check.mjs', import.meta.url));
    return spawnSync(process.execPath, [checker], {cwd: root, encoding: 'utf8'});
}

test('release check skips tracked files deleted from the working tree', async t => {
    const result = runChecker(await makeRoot(t));
    assert.equal(result.status, 0, result.stderr);
});

test('release check rejects Python service files in dist', async t => {
    const uuid = JSON.parse(await readFile(new URL('../../metadata.json', import.meta.url), 'utf8')).uuid;
    const result = runChecker(await makeRoot(t, {[`dist/${uuid}/service/x.py`]: ''}));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /service\/x\.py/);
});

test('release check rejects a non-ASCII character in a Python file', async t => {
    const result = runChecker(await makeRoot(t, {'service/bad.py': Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0a])}, ['service/bad.py']));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bad\.py:1 has a non-ASCII character/);
});
