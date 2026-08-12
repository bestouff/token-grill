import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('official Kiro PNG has the declared checksum and 256px dimensions', async () => {
  const root = new URL('../../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('resources/provider-assets.json', root), 'utf8'));
  const asset = manifest.assets.kiro;
  const png = await readFile(new URL(`resources/${asset.file}`, root));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.equal(createHash('sha256').update(png).digest('hex'), asset.sha256);
  assert.equal(asset.sourceSha256, 'dabfd74376ac150c86875271de07784bdd3c8d201807816a4d74d2b748d617a3');
});
