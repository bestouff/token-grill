import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The promise overload of the D-Bus proxy call that both processes use. Patching the
// prototype creates no objects, so it is safe at module scope.
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');

function isIoError(error: unknown, code: number): boolean {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, code);
}

export function isCancellation(error: unknown): boolean {
    return isIoError(error, Gio.IOErrorEnum.CANCELLED);
}
