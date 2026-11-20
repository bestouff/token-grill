import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Promise overloads for the async GIO calls used by both processes. Patching the
// prototypes creates no objects, so it is safe at module scope.
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'set_attributes_async', 'set_attributes_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

export function isIoError(error: unknown, code: number): boolean {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, code);
}

export function isCancellation(error: unknown): boolean {
    return isIoError(error, Gio.IOErrorEnum.CANCELLED);
}
