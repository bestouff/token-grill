import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';

// These are final GTypes in libadwaita 1.7+ (checked with GObject.type_test_flags(..., FINAL)).
// A GObject class cannot extend them: the Preferences process fails with "Cannot inherit from a
// final type". Hold one in a non-final container such as Adw.Bin instead.
const FINAL_TYPES = [
    'Adw.StatusPage',
    'Adw.AboutDialog',
    'Adw.AboutWindow',
    'Adw.Spinner',
    'Adw.SpinnerPaintable',
    'Adw.Avatar',
    'Adw.Banner',
    'Adw.Clamp',
    'Adw.Carousel',
    'Adw.ViewStack',
    'Adw.ToastOverlay',
    'Adw.ButtonContent',
    'Adw.SplitButton',
];

async function* sources(dir) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory())
            yield* sources(path);
        else if (entry.name.endsWith('.ts'))
            yield path;
    }
}

test('no class in src/ extends a final GType', async () => {
    const root = new URL('../../src', import.meta.url).pathname;
    const extended = new Map();
    for await (const path of sources(root)) {
        const text = await readFile(path, 'utf8');
        for (const m of text.matchAll(/class\s+\w+\s+extends\s+([\w.]+)/g))
            extended.set(`${path}:${m[1]}`, m[1]);
    }
    assert.ok(extended.size > 10, 'the scan found the classes');
    const bad = [...extended].filter(([, base]) => FINAL_TYPES.includes(base)).map(([key]) => key);
    assert.deepEqual(bad, []);
});
