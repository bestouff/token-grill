import {cp, mkdir, readFile, readdir, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const bin = name => path.join(root, 'node_modules', '.bin', name);
const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
const dist = path.join(root, 'dist', metadata.uuid);

await rm(dist, {recursive: true, force: true});
await mkdir(dist, {recursive: true});

// One readable .js file per .ts module, mirroring src/. Type errors are
// reported by `npm run check`; emitting here keeps the build usable while
// the checker runs separately.
try {
    execFileSync(bin('tsc'), ['-p', 'tsconfig.json', '--outDir', dist], {cwd: root, stdio: 'inherit'});
} catch {
    console.warn('tsc reported type errors; run `npm run check` for details.');
}

// tsc drops blank lines and uses its own spacing. Reformat the shipped code
// with the GNOME ESLint rules, then fail the build if anything is left.
const shippedJs = path.relative(root, dist);
execFileSync(bin('eslint'), ['--fix', '--no-warn-ignored', shippedJs], {cwd: root, stdio: 'ignore'});
execFileSync(bin('eslint'), ['--no-warn-ignored', shippedJs], {cwd: root, stdio: 'inherit'});

const copies = [
    ['metadata.json', 'metadata.json'],
    ['LICENSE', 'LICENSE'],
    ['resources/stylesheet.css', 'stylesheet.css'],
    ['resources/prefs.css', 'prefs.css'],
    ['resources/pricing/pricing-v1.json', 'pricing-v1.json'],
    ['resources/icons/token-grill-symbolic.svg', 'token-grill-symbolic.svg'],
    ['schemas/org.gnome.shell.extensions.tokengrill.gschema.xml', 'schemas/org.gnome.shell.extensions.tokengrill.gschema.xml'],
];
for (const folder of ['providers', 'pace']) {
    for (const icon of await readdir(path.join(root, 'resources', 'icons', folder)))
        copies.push([`resources/icons/${folder}/${icon}`, `icons/${folder}/${icon}`]);
}

for (const [source, target] of copies) {
    await mkdir(path.dirname(path.join(dist, target)), {recursive: true});
    await cp(path.join(root, source), path.join(dist, target));
}

console.log(`Built ${dist}`);
