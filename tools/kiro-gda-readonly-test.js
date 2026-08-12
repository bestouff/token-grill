import Gda from 'gi://Gda?version=5.0';
import GLib from 'gi://GLib';

Gda.init();
const directory = GLib.dir_make_tmp('tokengrill-kiro-gda-XXXXXX');
const database = GLib.build_filenamev([directory, 'fixture.sqlite3']);
try {
    const writable = Gda.Connection.open_from_string('SQLite', `DB_DIR=${directory};DB_NAME=fixture.sqlite3`, null, Gda.ConnectionOptions.NONE);
    writable.execute_non_select_command('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    writable.execute_non_select_command("INSERT INTO auth_kv VALUES ('kirocli:odic:token', '{\"access_token\":\"sanitized\"}')");
    writable.close();
    const readonly = Gda.Connection.open_from_string('SQLite', `DB_DIR=${directory};DB_NAME=fixture.sqlite3`, null, Gda.ConnectionOptions.READ_ONLY);
    readonly.execute_select_command('PRAGMA query_only = ON');
    const model = readonly.execute_select_command("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'");
    if (model.get_n_rows() !== 1 || String(model.get_value_at(0, 0)) !== '{"access_token":"sanitized"}') throw new Error('Gda could not read the Kiro fixture');
    let refusedWrite = false;
    try { readonly.execute_non_select_command("UPDATE auth_kv SET value = 'changed'"); } catch { refusedWrite = true; }
    readonly.close();
    if (!refusedWrite) throw new Error('Gda read-only mode accepted a write');
    print('Kiro Gda read-only integration passed');
} finally {
    try { GLib.unlink(database); } catch { /* cleanup */ }
    try { GLib.rmdir(directory); } catch { /* cleanup */ }
}
