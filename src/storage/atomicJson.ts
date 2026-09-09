import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'set_attributes_async', 'set_attributes_finish');

export function isCancellation(error: unknown): boolean {
    return Boolean((error as {matches?: (domain: unknown, code: number) => boolean})?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
}

export async function readJson<T>(path: string, fallback: T, cancellable: Gio.Cancellable | null = null): Promise<T> {
    try {
        const file = Gio.File.new_for_path(path);
        const info = await file.query_info_async('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 4 * 1024 * 1024) return fallback;
        const [bytes] = await file.load_contents_async(cancellable);
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch (error) {
        if (isCancellation(error)) throw error;
        return fallback;
    }
}

async function ensureDirectory(directory: Gio.File, cancellable: Gio.Cancellable | null): Promise<void> {
    let created = true;
    try {
        await directory.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if ((error as {matches?: (domain: unknown, code: number) => boolean})?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
            created = false;
        } else {
            if (!(error as {matches?: (domain: unknown, code: number) => boolean})?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;
            const parent = directory.get_parent();
            if (!parent) throw error;
            await ensureDirectory(parent, cancellable);
            try {
                await directory.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
            } catch (retryError) {
                if ((retryError as {matches?: (domain: unknown, code: number) => boolean})?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) created = false;
                else throw retryError;
            }
        }
    }

    if (!created) return;
    const permissions = new Gio.FileInfo();
    permissions.set_attribute_uint32('unix::mode', 0o700);
    await directory.set_attributes_async(permissions, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
}

export async function writeJsonAtomic(path: string, value: unknown, cancellable: Gio.Cancellable | null = null): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const file = Gio.File.new_for_path(path);
    const parent = file.get_parent();
    if (parent) await ensureDirectory(parent, cancellable);
    await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, cancellable);
    const permissions = new Gio.FileInfo();
    permissions.set_attribute_uint32('unix::mode', 0o600);
    await file.set_attributes_async(permissions, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
}

export function dataPath(filename: string): string {
    const base = GLib.getenv('XDG_DATA_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share']);
    return GLib.build_filenamev([base, 'token-grill', filename]);
}

export function statePath(filename: string): string {
    const base = GLib.getenv('XDG_STATE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
    return GLib.build_filenamev([base, 'token-grill', filename]);
}
