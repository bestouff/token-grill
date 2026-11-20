// Reads synthetic kiro-cli and Cursor databases through the built extension's
// Gda code, then confirms that a read-only connection refuses writes and that
// reading a closed write-ahead-log database leaves no files beside it. Uses no
// network and no real data. Run `npm run build` first.
import Gda from 'gi://Gda?version=5.0';
import GLib from 'gi://GLib';
import System from 'system';

const root = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const [, metadata] = GLib.file_get_contents(`${root}/metadata.json`);
const dist = `${root}/dist/${JSON.parse(new TextDecoder().decode(metadata)).uuid}`;
const {readKiroAuth} = await import(`file://${dist}/providers/kiro/auth.js`);
const {readCursorAuth} = await import(`file://${dist}/providers/cursor/auth.js`);

function listDirectory(directory) {
    const names = [];
    const dir = GLib.Dir.open(directory, 0);
    for (let name = dir.read_name(); name !== null; name = dir.read_name())
        names.push(name);
    dir.close();
    return names.sort();
}

function removeDirectory(directory) {
    for (const name of listDirectory(directory))
        GLib.unlink(GLib.build_filenamev([directory, name]));
    GLib.rmdir(directory);
}

// libgda adds ".db" to the name of a new database unless told not to.
function create(directory, name, statements) {
    const connection = Gda.Connection.open_from_string('SQLite',
        `DB_DIR=${Gda.rfc1738_encode(directory)};DB_NAME=${Gda.rfc1738_encode(name)};APPEND_DB_EXTENSION=FALSE`, null, Gda.ConnectionOptions.NONE);
    for (const statement of statements) {
        if (statement.startsWith('PRAGMA'))
            connection.execute_select_command(statement);
        else
            connection.execute_non_select_command(statement);
    }
    connection.close();
    // libgda releases the SQLite handle, and with it the journal, only when the
    // connection is finalized.
    System.gc();
}

Gda.init();

// A directory name that needs RFC 1738 encoding in the connection string.
const kiroDirectory = GLib.dir_make_tmp('tokengrill kiro;XXXXXX');
const kiroDatabase = GLib.build_filenamev([kiroDirectory, 'data.sqlite3']);
const token = JSON.stringify({access_token: 'sanitized', expires_at: '2030-01-01T00:00:00Z', region: 'eu-central-1'});
const profile = JSON.stringify({arn: 'arn:aws:codewhisperer:eu-central-1:1:profile/fixture', profile_name: 'fixture'});
create(kiroDirectory, 'data.sqlite3', [
    'CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)',
    `INSERT INTO auth_kv VALUES ('kirocli:odic:token', '${token}')`,
    `INSERT INTO state VALUES ('api.codewhisperer.profile', '${profile}')`,
]);

const kiro = await readKiroAuth(kiroDatabase, null);
if (kiro.accessToken !== 'sanitized' || kiro.serviceRegion !== 'eu-central-1' || !kiro.profileArn)
    throw new Error('The Kiro fixture was not read correctly');

const readonly = Gda.Connection.open_from_string('SQLite', `DB_DIR=${Gda.rfc1738_encode(kiroDirectory)};DB_NAME=data.sqlite3`, null, Gda.ConnectionOptions.READ_ONLY);
readonly.execute_select_command('PRAGMA query_only = ON');
let refused = false;
try {
    readonly.execute_non_select_command("UPDATE auth_kv SET value = 'changed'");
} catch {
    refused = true;
}
readonly.close();
removeDirectory(kiroDirectory);
if (!refused)
    throw new Error('A read-only Gda connection accepted a write');

// Cursor keeps its state in write-ahead-log mode. When Cursor is closed, the
// -wal and -shm files are gone, and a reader must not create them.
const cursorDirectory = GLib.dir_make_tmp('tokengrill cursor;XXXXXX');
const cursorDatabase = GLib.build_filenamev([cursorDirectory, 'state.vscdb']);
// A JWT whose `exp` is in 2030; the signature part is not checked.
const claims = GLib.base64_encode(new TextEncoder().encode(JSON.stringify({exp: 1893456000}))).replaceAll('=', '');
const jwt = `eyJhbGciOiJub25lIn0.${claims}.sanitized`;
create(cursorDirectory, 'state.vscdb', [
    'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)',
    `INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', '${jwt}')`,
    "INSERT INTO ItemTable VALUES ('cursorAuth/cachedEmail', 'user@example.com')",
]);
// The rows are in the main file; this only marks it as a write-ahead-log
// database. libgda keeps the sidecar files, which a closed Cursor leaves none of.
create(cursorDirectory, 'state.vscdb', ['PRAGMA journal_mode = WAL']);
for (const suffix of ['-wal', '-shm'])
    GLib.unlink(`${cursorDatabase}${suffix}`);
const before = listDirectory(cursorDirectory).join(',');
if (before !== 'state.vscdb')
    throw new Error(`The closed Cursor fixture has extra files: ${before}`);

const cursor = await readCursorAuth(cursorDatabase, null);
if (cursor.accessToken !== jwt || cursor.email !== 'user@example.com' || cursor.expiresAt !== 1893456000000)
    throw new Error('The Cursor fixture was not read correctly');
System.gc();
const after = listDirectory(cursorDirectory).join(',');
removeDirectory(cursorDirectory);
if (after !== before)
    throw new Error(`Reading the closed Cursor database created files: ${after}`);
const copies = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'token-grill']);
const leftovers = GLib.file_test(copies, GLib.FileTest.IS_DIR) ? listDirectory(copies).filter(name => name.endsWith('.sqlite') || name.includes('.sqlite-')) : [];
if (leftovers.length)
    throw new Error(`The private copy was not removed: ${leftovers.join(',')}`);
console.log('Gda read-only checks passed for Kiro and Cursor');
