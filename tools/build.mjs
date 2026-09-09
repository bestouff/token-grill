import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
const dist = path.join(root, 'dist', metadata.uuid);
await rm(dist, {recursive: true, force: true});
await mkdir(dist, {recursive: true});
const esbuild = path.join(root, 'node_modules', '.bin', 'esbuild');
execFileSync(esbuild, ['src/extension.ts', '--bundle', '--format=esm', '--platform=neutral', '--external:gi://*', '--external:resource://*', `--outfile=${path.join(dist, 'extension.js')}`], {cwd: root, stdio: 'inherit'});
execFileSync(esbuild, ['src/prefs.ts', '--bundle', '--format=esm', '--platform=neutral', '--external:gi://*', '--external:resource://*', `--outfile=${path.join(dist, 'prefs.js')}`], {cwd: root, stdio: 'inherit'});
await cp(path.join(root, 'metadata.json'), path.join(dist, 'metadata.json'));
await cp(path.join(root, 'resources', 'icons', 'token-grill-symbolic.svg'), path.join(dist, 'token-grill-symbolic.svg'));
await cp(path.join(root, 'resources', 'pricing', 'pricing-v1.json'), path.join(dist, 'pricing-v1.json'));
await cp(path.join(root, 'resources', 'stylesheet.css'), path.join(dist, 'stylesheet.css'));
await cp(path.join(root, 'resources', 'prefs.css'), path.join(dist, 'prefs.css'));
await cp(path.join(root, 'resources', 'provider-assets.json'), path.join(dist, 'provider-assets.json'));
await cp(path.join(root, 'NOTICE.md'), path.join(dist, 'NOTICE.md'));
await cp(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
await mkdir(path.join(dist, 'icons', 'providers'), {recursive: true});
const providerAssets = JSON.parse(await readFile(path.join(root, 'resources', 'provider-assets.json'), 'utf8'));
for (const file of new Set(Object.values(providerAssets.assets).map(asset => asset.file))) {
    await mkdir(path.dirname(path.join(dist, file)), {recursive: true});
    await cp(path.join(root, 'resources', file), path.join(dist, file));
}
await mkdir(path.join(dist, 'schemas'), {recursive: true});
await cp(path.join(root, 'schemas', 'org.gnome.shell.extensions.tokengrill.gschema.xml'), path.join(dist, 'schemas', 'org.gnome.shell.extensions.tokengrill.gschema.xml'));
const files = [];
const walk = async directory => {
    for (const entry of await (await import('node:fs/promises')).readdir(directory, {withFileTypes: true})) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(child); else files.push(path.relative(dist, child));
    }
};
await walk(dist);
await writeFile(path.join(dist, 'MANIFEST'), `${files.sort().join('\n')}\n`);
console.log(`Built ${dist}`);
