# Token Grill: notes for coding agents

Token Grill has two parts. The GNOME Shell extension (`src/`, TypeScript) is
the UI and a D-Bus client. The Python service (`service/`, package
`tokengrill` on PyPI) reads the credentials of other tools, gets the usage
limits of Codex, Claude, Kiro, Antigravity, GitHub Copilot, OpenCode Go, Kimi
Code, and Cursor accounts and the DeepSeek balance, and serves them over
D-Bus. The extension shows them in the top bar. It operates with GNOME Shell
48, 49, 50, and 51. The target is extensions.gnome.org.

[PRACTICES.md](PRACTICES.md) is the set of rules. Each rule in it is a hard
rule. Before you change a file, read the sections that apply to that file.
[CONTRIBUTING.md](CONTRIBUTING.md) gives the procedures for persons.

## Architecture

Three process kinds exist: the service, the Shell process, and the
preferences process. The extension has no collectors and makes no network
request. A module of one process must not import the UI modules of another.

### The D-Bus contract

- `service/src/tokengrill/dbus/interface.xml` is the source of truth. The
  text in `src/dbus/interface.ts` must be identical (a unit test compares
  them). Names: bus `io.github.sh02sahil.TokenGrill`, path
  `/io/github/sh02sahil/TokenGrill`, interface
  `io.github.sh02sahil.TokenGrill1`.
- Structured data crosses as JSON strings with `"schema": 1` and the 0.4.1
  camelCase field names. No method or signal returns a token, a key, or the
  content of a file.
- `Hello(kind)` registers a client (`shell`, `prefs`, `cli`). `Goodbye()`
  removes it. The service exits 60 seconds after the last `shell` or `prefs`
  client has left.
- The scheduler, the history scans, and the alert decisions run only while a
  `shell` client is registered (shell-gated). The extension must call
  `Goodbye()` in `disable()`.
- An additive change raises `ApiVersion`. A breaking change makes a new
  interface name. The extension states the minimum `ApiVersion`.

### Extension: Shell process (`extension.js` and all the modules that it imports)

- `src/extension.ts`: `enable()` creates a `Runtime`, and `disable()` stops
  it. This file contains nothing more.

- `src/runtime.ts`: owns all objects that `enable()` creates: the settings,
  the cancellable, the `ServiceClient`, the notification store, and the
  indicator. `stop()` releases all of them.

- `src/client.ts`: `ServiceClient`, the D-Bus client. It builds the proxy
  asynchronously, calls `Hello`, follows the signals, and keeps the state. A
  missing or old service is a state of the client, not an error. It uses the
  one cancellable of its owner (the runtime, or the Preferences window) for
  every call except `Goodbye()` (see "Accepted exceptions").

- `src/shell/`: the panel button and the popup (`indicator.ts`, `topBar.ts`,
  `providerCard.ts`, `serviceCard.ts`, `accountChip.ts`, `toggleGroup.ts`),
  the notifications, and `signIn.ts` (opens a CLI login in the user's
  terminal with the command that `core/signIn.ts` builds).

- `src/core/`: code for both processes and the unit tests. It does not import
  Shell modules (`resource:///org/gnome/shell/...`) or GTK modules. Each
  function that makes text for the user gets a `Translator` (`core/i18n.ts`).
  The unit tests give `UNTRANSLATED`. The Shell gives `shell/translator.ts`.

**Preferences process** (`prefs.js`): `src/prefs.ts` makes the window from the
pages and dialogs in `src/prefs/`. It uses the same `ServiceClient`. It does
not import the modules of `src/shell/`.

### Service (`service/src/tokengrill/`)

- `cli.py`: the commands `setup`, `uninstall [--purge]`, `status [--json]
  [--refresh]`, `version`, and `run`.
- `service.py` and `dbus/`: the D-Bus object, the client list, and the idle
  exit. `core/`: the logic without I/O (scheduler, alerts, pace, config).
- `providers/`: one collector for each service. `providers/base.py` has the
  shared snapshot and history steps. `net/http.py` is the one HTTP client: a
  fixed list of hosts, only HTTPS, no redirects, a response cap of 1 MiB, a
  timeout of 30 s, and the single `USER_AGENT`.
- `providers/credentials.py`, `keyring.py`, `sqlite.py`, `jwt.py`: read the
  credential files, keyring items, and databases of other tools, read-only.
  `providers/history.py` reads the JSONL session logs.
- `storage/`: private atomic JSON files. The formats are the 0.4.1 formats.

The data flow:

1. The service scheduler selects the due accounts while a `shell` client is
   registered.
2. Each collector returns a new `ProviderSnapshot`. A `CollectorError` becomes
   a stale or an error snapshot.
3. The service keeps the snapshot, decides the alerts, and emits
   `AccountChanged` and `Alert`.
4. The extension shows the snapshot and writes the text of each alert.

## Where each rule lives

- The extension code (`src/`): [PRACTICES.md](PRACTICES.md) sections 3 to 18
  and "Invariants" below.
- The service code (`service/`): PRACTICES section "Service" (SV-1 to SV-14)
  and "Rules for the service" below.
- Process and text rules: PRACTICES sections 6 and 9, and "Rules for text".

## Commands

```bash
npm ci
npm run check          # tsc --noEmit, then ESLint (GNOME rules) on src/, tools/, tests/
npm test               # bundles pure modules into build/tests/, then node --test
npm run build          # per-file tsc emit into dist/<uuid>/, then GNOME ESLint over dist/
npm run release:check  # metadata, package tree, development traces, line length
npm run review:check   # pack, then Shexli on dist/ and on the zip; only the findings PRACTICES T-2 accepts
npm run install:local  # replaces the user's installed copy: only after nested-shell checks
npm run dev:shell      # nested GNOME Shell with the installed copy
```

In `service/` (after `python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`):

```bash
.venv/bin/pytest -q                 # unit tests
.venv/bin/pytest -q -m integration  # a real session bus, or the network
.venv/bin/ruff check . && .venv/bin/mypy src
```

## Examine a change

1. Run `npm run check`, `npm test`, `npm run build`, `npm run release:check`,
   and `npm run review:check`. Each command must show 0 findings, except the
   two Shexli findings that PRACTICES T-2 accepts.

2. If you change a collector or the network code of the service, run its
   integration test (`-m integration`) for each service that the change
   touches. Keep only the response keys that you saw in a real response. If
   you change `interface.xml`, copy it into `src/dbus/interface.ts`.

3. If you change the Shell code or the preferences, do a test in a nested
   shell. Do this test before you change the installed copy of the user. The
   nested shell needs a service: run `tokengrill setup` from the venv of
   `service/`.

4. Run the service checks above if you change `service/`.

5. Do not run `npm run install:local` on the real data directory before the
   user sees the results of the nested shell test.

The nested shell test:

1. Install into temporary directories:
   `XDG_DATA_HOME=/tmp/tg-data XDG_STATE_HOME=/tmp/tg-state npm run install:local`.

2. Run `dbus-run-session -- gnome-shell --devkit --wayland` with the same
   variables. Unset `GDK_BACKEND`.

3. Set `GSETTINGS_BACKEND=memory`, if you do not need the accounts of the
   user. Then enable the extension through the nested bus. Write
   `provider-instances-json` through Looking Glass or Eval.

4. Examine these items: `State: ACTIVE`, some disable and enable cycles, lock
   and unlock, the popup in the light style and the dark style, and the
   preferences window.

5. Make sure that the log shows no criticals, no warnings, and no "already
   disposed" messages.

CAUTION: Without `GSETTINGS_BACKEND=memory`, the nested shell uses the dconf
database of the real session. If you enable an extension in the nested shell,
it also changes on the desktop of the user. The same applies if you disable it.

## Invariants

Rules for the code:

- Use one code path for GNOME Shell 48 to 51. Use only the APIs that GNOME 48
  has and GNOME 51 does not remove. Do not add version checks (PRACTICES V-1).

- Do not use `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, or `any`. Use
  `as` casts only where the GI typings are not sufficient.

- Each GObject subclass uses one style:
  `class X extends Base { static { GObject.registerClass({GTypeName: 'TokenGrillX'}, this); } constructor(...) { super(...); } }`.
  Use `_field` names with TS `private`.

- Do not use an empty `catch` or a `catch` with only a comment. Do not use
  `.catch(() => {})`. Do not use `?.` or `typeof` checks on values that are
  always present. Do not use boolean flags for the lifecycle.

- Each `src/**/*.ts` file goes into the release as its own `.js` file. If no
  module imports a file, delete the file.

- The extension imports no `Secret` or `Gda`, makes no network request, and
  starts no subprocess except the terminal of "Sign In Again in a Terminal".
  It never reads the clipboard.

- Python: ruff and mypy `strict` pass, no `# type: ignore` without a reason in
  `pyproject.toml`, and no bare `except`. A failure in a collector is a
  `ServiceError` or a bug. A bug is logged and becomes the `internal` error.

- A comment tells why, not what. Do not write narration, step numbers,
  version hedges, TODOs, or AI or prompt text (PRACTICES section 2).

Rules for text:

- Use ASCII only, in every file (PRACTICES Q-17): `...`, `'` and ` - `
  instead of an ellipsis, a curly apostrophe or a middle dot. Do not use
  escapes such as `\u00B7` either.

- Each text for the user goes through `_()` or `ngettext()` with a literal
  msgid. Use `formatText()` or `.format()` for placeholders. Do not use template
  literals in `_()`.

- Service names ("Codex", "Claude", "Kiro", "Antigravity") stay as plain text
  (PRACTICES LE-3a).

- The service sends an error as `errorInfo = {code, messageId, params,
  recovery}`. The English texts are in `service/src/tokengrill/core/messages.py`
  and the translated texts are in `src/core/serviceMessages.ts`. The message
  tells only the problem. `errorText()` in `core/popupModel.ts` adds the
  correction for each service.

- In a collector, a failure is a `ServiceError` or a bug. A `ServiceError`
  becomes a stale snapshot or an error snapshot. A bug goes to the log of the
  service and becomes the `internal` error. Do not catch all errors.

Rules for the service (network and data):

- Use only the hosts in `service/src/tokengrill/net/http.py`
  (`ALLOWED_HOSTS` and the Kiro OIDC pattern). Use only HTTPS, accept no
  redirects, reject a response over 1 MiB, and stop a request after 30 s.

- Use one User-Agent (`USER_AGENT`). Set it on the HTTP client. Do not set a
  User-Agent on one request. Do not send the exact identity of a different
  client or browser headers.

- Never put a token, a key, or an e-mail address in a D-Bus payload that the
  user did not ask for, in a file, or in a log. The only secret that enters the
  service is a pasted API key (`SaveApiKey`, and `apiKey` of `AddAccounts`).

- If you add a host, also add it to the host table in the README (under "The
  service") and to the description in `metadata.json`.

- Read the files and keyrings of other tools read-only, off the event loop. Do
  not write to them. Keep refreshed tokens only in memory. Do not unlock a
  keyring. Do not decrypt the secrets of another app.

- Do not exchange a token whose refresh token is single-use (Codex, Claude):
  the CLI keeps the old one, so a refresh by Token Grill signs the CLI out.
  For expired Claude Code credentials, the service delegates renewal to
  `claude auth status` and rereads the file (SV-5). The CLI owns the writes
  and refresh locking. Kiro and Antigravity tokens can be refreshed in memory.

- Usage pace needs `UsageWindow.durationSeconds`. Take it from what the
  service reports: a duration field (Codex), the window's own name, such as
  Claude's `five_hour` or Antigravity's `5h` bucket (`namedLength()`), or the
  month before a monthly reset date (`monthBefore()`). Do not derive it from a
  type that Token Grill assigned itself.

- Do not hardcode an account, an e-mail address, or a personal path (for
  example `~/.t3`). The data that the CLI of each service keeps is correct.
  Many accounts of one service must operate at the same time.

Other rules:

- Each service icon is an original image (`*-symbolic.svg`). Do not add
  logos or brand artwork.

- The totals of `providers/history.py` add up. If you change `PARSER_VERSION`,
  Token Grill reads each history file again and counts it two times.

- The version in `package.json` and the `version-name` key in `metadata.json`
  must be the same. The service has its own version in
  `service/src/tokengrill/__init__.py`. `CHANGELOG.md` lists the changes for users.

- Do not commit, make a branch, or open a pull request if the user does not
  ask for it.

## Accepted exceptions

These exceptions are intentional. Do not change them if the reason stays the
same.

- **The service reads the Kiro and Cursor databases with `sqlite3`, which is
  synchronous.** The service runs the read in a worker thread. It first
  examines the size and the modification time of the database and its `-wal`
  file, and reads the database only after a change (`providers/sqlite.py`). A
  write-ahead-log database without its `-wal` and `-shm` files is read from a
  private copy in `$XDG_RUNTIME_DIR/token-grill/`, because SQLite creates
  those files beside a database that it opens.

- **The scheduler of the service starts every 15 s** and examines the due times
  in memory. It runs only while a `shell` client is registered.

- **The toggle colors of the popup are fixed rgba values** in
  `resources/stylesheet.css`. St has no `currentColor`. Thus, `indicator.ts`
  measures the text color of the menu and selects the dark or the
  `tokengrill-light` color set. The meter fills and the warning and critical
  colors are fixed values chosen in the same way, because accent colors fail
  contrast on some styles. The top-bar ring fill reads them from the
  stylesheet with `lookup_color()`. The accent colors of the accounts are data
  from the user, not theme colors (UI-10).

- **`StayOpenMenuItem` and `WindowItem` override `activate()`.** They do not
  call `super.activate()`, so the menu stays open: after "Refresh All
  Accounts" it shows the progress, and after a click on a limit
  (`shell/providerCard.ts`) it shows the new check mark. These are subclasses
  of a menu item, not patches of Shell code (R-17).

- **`Goodbye()` is sent without the cancellable.** The client sends it when it
  drops its proxy, which `disable()` does after it has cancelled the
  cancellable of its owner. A call with that cancellable would not be sent.
  The call has no callback, so nothing runs after `disable()`.

- **`isCancellation()` finds cancellations, and errors go to `getLogger()`.**
  `logErrorUnlessCancelled()` has no typings and does not use the logger of
  the extension (R-12, LG-4).

- **The User-Agent names the monitored services.** The Antigravity quota API
  (`cloudcode-pa`) returns 403 if the User-Agent does not contain Antigravity.
  The HTTP client of the service sets one User-Agent for every request. Thus,
  the single `USER_AGENT` identifies Token Grill and names the services that
  it reads (SV-2, Q-12). It does not claim to be the Antigravity
  app or the agy CLI.


- **"Sign In Again in a Terminal" launches the CLI login of an account.** It
  runs only when the user clicks it. The command and its arguments come from
  the fixed table in `core/signIn.ts`, never from a D-Bus reply. For an
  account outside the default home (the service sends `homeIsDefault`), `env`
  sets the CLI's own variable (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
  `GH_CONFIG_DIR`), so the right account signs in. The value of that variable
  is the account home from the account data; it is one argument, quoted with
  `GLib.shell_quote()`. `shell/signIn.ts` uses `Gio.AppInfo.create_from_commandline()`
  with `NEEDS_TERMINAL`, so GLib picks the terminal and no shell parses the
  command (X-3, X-4).

- **The Copy buttons write a fixed setup command to the clipboard.** The popup
  (`shell/serviceCard.ts`) calls `St.Clipboard.set_text()`. The preferences
  (`prefs/serviceBanner.ts`) call
  `Gdk.Display.get_default().get_clipboard().set()`. The command is one that
  Token Grill wrote (for example `pipx install tokengrill &&
  ~/.local/bin/tokengrill setup`). The write happens only after a click. Token
  Grill never reads the clipboard. The description in `metadata.json` declares
  this (LE-6).
