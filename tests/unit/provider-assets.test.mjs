import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('LobeHub monochrome assets have the declared checksums and provenance', async () => {
  const root = new URL('../../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('resources/provider-assets.json', root), 'utf8'));
  assert.equal(Object.keys(manifest.assets).length, 21);
  for (const asset of Object.values(manifest.assets)) {
    const svg = await readFile(new URL(`resources/${asset.file}`, root));
    assert.match(svg.toString(), /<svg.*viewBox=/);
    assert.equal(createHash('sha256').update(svg).digest('hex'), asset.sha256);
    assert.ok(asset.sourceUrl.includes(`lobehub/lobe-icons/${manifest.revision}/`));
  }
  const license = await readFile(new URL('resources/icons/providers/LOBEHUB-LICENSE.txt', root), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2023 LobeHub/);
});
