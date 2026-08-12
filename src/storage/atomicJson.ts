import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

export async function readJson<T>(path: string, fallback: T): Promise<T> {
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 4 * 1024 * 1024) return fallback;
        const [bytes] = await file.load_contents_async(null);
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
        return fallback;
    }
}

export function readJsonSync<T>(path: string, fallback: T): T {
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 4 * 1024 * 1024) return fallback;
        const [, bytes] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
        return fallback;
    }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const file = Gio.File.new_for_path(path);
    const parent = file.get_parent();
    const parentPath = parent?.get_path();
    if (parentPath) {
        GLib.mkdir_with_parents(parentPath, 0o700);
        GLib.chmod(parentPath, 0o700);
    }
    const tmp = Gio.File.new_for_path(`${path}.tmp-${GLib.uuid_string_random()}`);
    const text = JSON.stringify(value);
    tmp.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
    tmp.move(file, Gio.FileCopyFlags.OVERWRITE, null, null);
    GLib.chmod(path, 0o600);
}

export function dataPath(filename: string): string {
    const base = GLib.getenv('XDG_DATA_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share']);
    return GLib.build_filenamev([base, 'token-grill', filename]);
}

export function statePath(filename: string): string {
    const base = GLib.getenv('XDG_STATE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
    return GLib.build_filenamev([base, 'token-grill', filename]);
}
