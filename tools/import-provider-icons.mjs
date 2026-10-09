import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Pin upstream so refreshing packaged assets is reproducible.
const revision = 'c385b2b8d1f9e19aa86e628d4e23c91ee1111a47';
const base = `https://raw.githubusercontent.com/lobehub/lobe-icons/${revision}`;
const assets = {};
const provenance = [];
for (const name of ['openai', 'claude', 'kiro', 'antigravity', 'deepseek', 'kimi', 'opencode']) {
    const response = await fetch(`${base}/packages/static-svg/icons/${name}.svg`);
    if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`);
    const svg = await response.text();
    for (const [appearance, color] of [['light', '#ffffff'], ['dark', '#000000'], ['symbolic', '#2e3436']]) {
        const file = appearance === 'symbolic' ? `icons/providers/${name}-symbolic.svg` : `icons/providers/${name}-mono-${appearance}.svg`;
        const contents = svg.replaceAll('currentColor', color);
        const sha256 = createHash('sha256').update(contents).digest('hex');
        await writeFile(`resources/${file}`, contents);
        assets[`${name}-${appearance}`] = {file, source: 'LobeHub monochrome icons (MIT)', sourceUrl: `${base}/packages/static-svg/icons/${name}.svg`, sha256};
        provenance.push(`- ${name} ${appearance}: SHA-256 \`${sha256}\``);
    }
}
const license = await fetch(`${base}/LICENSE`);
if (!license.ok) throw new Error('Could not download the icon license.');
await writeFile('resources/icons/providers/LOBEHUB-LICENSE.txt', await license.text());
await writeFile('resources/provider-assets.json', `${JSON.stringify({schemaVersion: 1, policy: 'Provider marks identify configured services and are not Token Grill branding.', revision, assets}, null, 2)}\n`);
await writeFile('NOTICE.md', `# Third-party names and marks

Token Grill uses provider marks to identify configured services. All provider
names and marks remain the property of their respective owners. Token Grill
is independent and is not endorsed by or affiliated with those providers.

All seven provider marks come from [LobeHub's monochrome icon set](https://lobehub.com/icons?type=mono),
at [revision ${revision}](https://github.com/lobehub/lobe-icons/tree/${revision}).
The vector geometry is unchanged. Symbolic variants let GNOME Shell and GTK
color the logos from their actual foreground color; fixed white and black
variants are also included. LobeHub's MIT license and copyright
notice are included in resources/icons/providers/LOBEHUB-LICENSE.txt.

Regenerate the assets and this provenance with \`node tools/import-provider-icons.mjs\`.
The source URL and packaged checksum of every asset are in resources/provider-assets.json.

${provenance.join('\n')}

## Bundled TOML parser

Token Grill bundles [smol-toml](https://github.com/squirrelchat/smol-toml)
to read Kimi CLI configuration. Its BSD-3-Clause license and copyright notice
are included in resources/SMOL-TOML-LICENSE.txt.
`);
