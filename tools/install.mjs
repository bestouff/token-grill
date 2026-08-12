import {cp, mkdir, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {execFileSync} from 'node:child_process';

const root = process.cwd();
const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
const uuid = metadata.uuid;
execFileSync('npm', ['run', 'build'], {cwd: root, stdio: 'inherit'});
const dataHome = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local', 'share');
const target = path.join(dataHome, 'gnome-shell', 'extensions', uuid);
await mkdir(path.dirname(target), {recursive: true});
try {
    const installedMetadata = JSON.parse(await readFile(path.join(target, 'metadata.json'), 'utf8'));
    if (installedMetadata.uuid !== uuid)
        throw new Error(`Refusing to replace extension with UUID ${installedMetadata.uuid}`);
    // Replace our own development install atomically enough for local use and,
    // importantly, do not leave removed runtime assets behind between builds.
    await rm(target, {recursive: true});
} catch (error) {
    if (error?.code !== 'ENOENT') throw error;
}
await cp(path.join(root, 'dist', uuid), target, {recursive: true, force: true});
console.log(`Installed extension at ${target}`);
if (process.argv.includes('--enable')) {
    execFileSync('gnome-extensions', ['enable', uuid], {stdio: 'inherit'});
    console.log(`Requested enable for ${uuid}.`);
}
console.log('On Wayland, restart the nested GNOME Shell or log out/in to load changed JavaScript.');
