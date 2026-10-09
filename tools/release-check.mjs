import {readFile, readdir, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
const errors = [];
const expectedUuid = 'tokengrill@sh02sahil.github.io';
const expectedUrl = 'https://github.com/sh02sahil/token-grill';
const allowedMetadataKeys = new Set(['name', 'description', 'uuid', 'url', 'shell-version', 'settings-schema', 'version']);

if (metadata.uuid !== expectedUuid) errors.push(`Public UUID must be ${expectedUuid}.`);
if (metadata.url !== expectedUrl) errors.push(`Project URL must be ${expectedUrl}.`);
if (JSON.stringify(metadata['shell-version']) !== JSON.stringify(['50'])) errors.push('The first release must target GNOME Shell 50 only.');
if (metadata['settings-schema'] !== 'org.gnome.shell.extensions.tokengrill') errors.push('Unexpected settings schema.');
for (const key of Object.keys(metadata)) if (!allowedMetadataKeys.has(key)) errors.push(`Unnecessary metadata key: ${key}`);
if (metadata.version !== undefined && (!Number.isInteger(metadata.version) || metadata.version < 1)) errors.push('Extension version must be a positive integer.');

const shellSource = await readFile(path.join(root, 'src', 'shell', 'indicator.ts'), 'utf8') + await readFile(path.join(root, 'src', 'shell', 'providerCard.ts'), 'utf8');
if (shellSource.includes('set_tooltip_text')) errors.push('Shell code must not call GTK-only set_tooltip_text().');
const runtimeSource = await readFile(path.join(root, 'src', 'extension.ts'), 'utf8') + await readFile(path.join(root, 'src', 'shell', 'indicator.ts'), 'utf8');
if (/child_process|execFile|spawn\s*\(|GLib\.spawn/i.test(runtimeSource)) errors.push('Runtime code must not launch subprocesses.');

try {
    const manifest = JSON.parse(await readFile(path.join(root, 'resources', 'provider-assets.json'), 'utf8'));
    const notice = await readFile(path.join(root, 'NOTICE.md'), 'utf8');
    for (const [kind, asset] of Object.entries(manifest.assets || {})) {
        const file = path.join(root, 'resources', asset.file);
        const digest = createHash('sha256').update(await readFile(file)).digest('hex');
        if (digest !== asset.sha256) errors.push(`Provider asset checksum mismatch: ${kind}`);
        if (!notice.includes(asset.sha256)) errors.push(`NOTICE is missing the checksum for ${kind}.`);
        if (path.extname(file) === '.svg') {
            const svg = await readFile(file, 'utf8');
            if (!svg.includes('<svg') || !svg.includes('viewBox') || !svg.includes('<path')) errors.push(`Provider asset is not a valid vector: ${kind}`);
        } else if (path.extname(file) === '.png') {
            const png = await readFile(file);
            if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) errors.push(`Provider asset is not a valid PNG: ${kind}`);
            if (png.readUInt32BE(16) !== asset.width || png.readUInt32BE(20) !== asset.height) errors.push(`Provider asset dimensions mismatch: ${kind}`);
        } else errors.push(`Provider asset type is unsupported: ${kind}`);
    }
} catch (error) {
    errors.push(`Provider asset validation failed: ${error.message}`);
}

const forbidden = [
    new RegExp(['tokengrill', 'local'].join('@'), 'i'),
    new RegExp(['tokens', '4', 'breakfast'].join('[ _-]*'), 'i'),
    new RegExp(['replace', 'me'].join('-'), 'i'),
    new RegExp(['replace-with-your', 'public-uuid'].join('-'), 'i'),
    new RegExp(['Do NOT', 'upload'].join(' '), 'i'),
    new RegExp(['personal use', 'Review before public submission'].join('\\. '), 'i'),
];
const textExtensions = new Set(['.md', '.json', '.mjs', '.js', '.ts', '.xml', '.sh', '.css', '.svg', '.txt']);
async function scanTree(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (['.git', 'node_modules', 'dist', 'build'].includes(entry.name)) continue;
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) await scanTree(child);
        else if (textExtensions.has(path.extname(entry.name))) {
            const text = await readFile(child, 'utf8');
            for (const pattern of forbidden) if (pattern.test(text)) errors.push(`Private-development trace in ${path.relative(root, child)}: ${pattern}`);
        }
    }
}
await scanTree(root);

for (const screenshot of ['panel-indicator.png', 'usage-dashboard.png']) {
    try { if ((await stat(path.join(root, 'docs', 'screenshots', screenshot))).size < 10_000) errors.push(`Screenshot is unexpectedly small: ${screenshot}`); }
    catch { errors.push(`README screenshot is missing: ${screenshot}`); }
}

const dist = path.join(root, 'dist', metadata.uuid);
try {
    const packaged = [];
    async function walk(directory) {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(child); else packaged.push(path.relative(dist, child));
        }
    }
    await walk(dist);
    for (const required of ['metadata.json', 'extension.js', 'prefs.js', 'LICENSE', 'NOTICE.md', 'schemas/org.gnome.shell.extensions.tokengrill.gschema.xml'])
        if (!packaged.includes(required)) errors.push(`Required release file is missing: ${required}`);
    for (const file of packaged) if (/\.map$|node_modules|\.ts$|tests?\//.test(file)) errors.push(`Development-only file is packaged: ${file}`);
    if (packaged.includes('schemas/gschemas.compiled')) errors.push('Compiled settings schemas must not be present in dist/.');
    const packagedMetadata = JSON.parse(await readFile(path.join(dist, 'metadata.json'), 'utf8'));
    if (packagedMetadata.uuid !== metadata.uuid) errors.push('Packaged metadata UUID differs from source metadata.');
} catch {
    errors.push('Build the extension before running release validation.');
}

const releaseZip = path.join(root, 'build', 'releases', `${metadata.uuid}.shell-extension.zip`);
try {
    await stat(releaseZip);
    const entries = execFileSync('unzip', ['-Z1', releaseZip], {encoding: 'utf8'}).split('\n').filter(Boolean);
    if (entries.includes('schemas/gschemas.compiled')) errors.push('Compiled settings schemas must not be present in the release ZIP.');
} catch (error) {
    if (error?.code !== 'ENOENT') errors.push(`Could not inspect the existing release ZIP: ${error.message}`);
}

if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
} else {
    console.log(`Release metadata and package tree are ready for ${metadata.uuid}.`);
}
