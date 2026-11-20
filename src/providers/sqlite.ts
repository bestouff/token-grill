import type Gda from 'gi://Gda?version=5.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CollectorError} from '../core/errors.js';
import {isCancellation, isIoError} from '../core/gio.js';
import {formatText} from '../core/i18n.js';
import {credentialFileError} from './credentials.js';

const STAMP_ATTRIBUTES = 'standard::size,time::modified,time::modified-usec';
// Byte 18 of an SQLite header is 2 when the database keeps a write-ahead log.
const HEADER_BYTES = 20;
const WAL_FORMAT = 2;

export type SelectText = (query: string) => string | null;

async function importGda(service: string): Promise<typeof Gda> {
    let module: {default: typeof Gda};
    try {
        module = await import('gi://Gda?version=5.0');
    } catch {
        throw new CollectorError('dependency', ({_}) => formatText(_('%s accounts need the Gda 5.0 library (gir1.2-gda-5.0).'), service));
    }
    module.default.init();
    return module.default;
}

async function fileStamp(path: string, cancellable: Gio.Cancellable | null): Promise<string | null> {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            STAMP_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        const modified = `${info.get_attribute_uint64('time::modified')}.${info.get_attribute_uint32('time::modified-usec')}`;
        return `${modified}:${info.get_size()}`;
    } catch (error) {
        if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw error;
    }
}

// Changes when the owning app writes to its database, including writes still
// held in the write-ahead log. Null when the database does not exist.
export async function databaseStamp(path: string, cancellable: Gio.Cancellable | null): Promise<string | null> {
    let stamps: Array<string | null>;
    try {
        stamps = await Promise.all([fileStamp(path, cancellable), fileStamp(`${path}-wal`, cancellable)]);
    } catch (error) {
        throw credentialFileError(error, path);
    }
    return stamps[0] === null ? null : stamps.join('|');
}

async function usesWriteAheadLog(path: string, cancellable: Gio.Cancellable | null): Promise<boolean> {
    const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, cancellable);
    try {
        const header = await stream.read_bytes_async(HEADER_BYTES, GLib.PRIORITY_DEFAULT, cancellable);
        return header.get_data()?.[18] === WAL_FORMAT;
    } finally {
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    }
}

// SQLite creates the -wal and -shm files of a write-ahead-log database when a
// reader opens it without them, which is the case while the owning app is
// closed. Then a private copy is read, so nothing appears beside the original.
async function needsPrivateCopy(path: string, cancellable: Gio.Cancellable | null): Promise<boolean> {
    const [wal, shm] = await Promise.all([fileStamp(`${path}-wal`, cancellable), fileStamp(`${path}-shm`, cancellable)]);
    if (wal !== null && shm !== null)
        return false;
    return usesWriteAheadLog(path, cancellable);
}

async function privateCopyPath(cancellable: Gio.Cancellable | null): Promise<string> {
    const directory = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_runtime_dir(), 'token-grill']));
    try {
        await directory.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (!isIoError(error, Gio.IOErrorEnum.EXISTS))
            throw error;
    }
    return GLib.build_filenamev([directory.get_path()!, `${GLib.uuid_string_random()}.sqlite`]);
}

async function removePrivateCopy(path: string): Promise<void> {
    await Promise.all(['', '-wal', '-shm'].map(async suffix => {
        try {
            await Gio.File.new_for_path(`${path}${suffix}`).delete_async(GLib.PRIORITY_DEFAULT, null);
        } catch (error) {
            if (!isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
        }
    }));
}

function selectText(connection: Gda.Connection, query: string): string | null {
    const model = connection.execute_select_command(query);
    if (model.get_n_rows() < 1)
        return null;
    const value = model.get_value_at(0, 0);
    return typeof value === 'string' ? value : null;
}

// libgda 5 offers no asynchronous queries. The read is a few small rows, and
// callers only make it after the database changed on disk.
function readOpenDatabase<T>(gda: typeof Gda, path: string, read: (select: SelectText) => T): T {
    const directory = gda.rfc1738_encode(GLib.path_get_dirname(path));
    const name = gda.rfc1738_encode(GLib.path_get_basename(path));
    const connection = gda.Connection.open_from_string('SQLite', `DB_DIR=${directory};DB_NAME=${name}`, null, gda.ConnectionOptions.READ_ONLY);
    try {
        // READ_ONLY is advisory in some libgda SQLite builds; query_only makes
        // SQLite itself refuse writes. libgda classifies PRAGMA as a selection.
        connection.execute_select_command('PRAGMA query_only = ON');
        return read(query => selectText(connection, query));
    } finally {
        connection.close();
    }
}

// Reads another app's database read-only. Errors of the database become
// `unreadable`; errors that `read` throws pass through.
export async function readDatabase<T>(
    path: string,
    service: string,
    cancellable: Gio.Cancellable | null,
    read: (select: SelectText) => T,
    unreadable: () => CollectorError
): Promise<T> {
    const gda = await importGda(service);
    let copy: string | null = null;
    try {
        if (await needsPrivateCopy(path, cancellable)) {
            copy = await privateCopyPath(cancellable);
            const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
            await Gio.File.new_for_path(copy).replace_contents_bytes_async(contents, null, false, Gio.FileCreateFlags.PRIVATE, cancellable);
        }
        return readOpenDatabase(gda, copy ?? path, read);
    } catch (error) {
        if (isCancellation(error) || !(error instanceof GLib.Error))
            throw error;
        throw unreadable();
    } finally {
        if (copy)
            await removePrivateCopy(copy);
    }
}
