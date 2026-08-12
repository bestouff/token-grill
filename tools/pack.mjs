import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {execFileSync} from 'node:child_process';

const root = process.cwd();
const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
execFileSync('npm', ['run', 'check'], {cwd: root, stdio: 'inherit'});
execFileSync('npm', ['run', 'build'], {cwd: root, stdio: 'inherit'});
const output = path.join(root, 'build', 'releases');
await mkdir(output, {recursive: true});
execFileSync('gnome-extensions', [
    'pack', '--force', '--schema=schemas/org.gnome.shell.extensions.tokengrill.gschema.xml',
    '--extra-source=token-grill-symbolic.svg', '--extra-source=pricing-v1.json',
    '--extra-source=prefs.css', '--extra-source=provider-assets.json', '--extra-source=NOTICE.md', '--extra-source=LICENSE',
    '--extra-source=icons',
    '--out-dir', output, path.join(root, 'dist', metadata.uuid),
], {stdio: 'inherit'});
