# Contributing to Token Grill

Thank you for your help with Token Grill. Small changes with good tests are
easy to review.

## Rules

[PRACTICES.md](PRACTICES.md) is the set of rules for this repository. It applies
to persons and to AI agents (H-1). Each rule in it is a hard rule. In reviews and
commit messages, refer to rules by their ID, for example `L-3` or `T-3` (H-6).

## Before you start

Token Grill has two parts. The GNOME Shell extension is in `src/`. It shows
the results and is a D-Bus client. The Python service is in `service/`. It reads
the sign-ins, gets the usage limits, and serves them over D-Bus. The contract
between them is `service/src/tokengrill/dbus/interface.xml`.

Token Grill operates with GNOME Shell 48, 49, 50, and 51. The extension uses
one code path for all four versions (PRACTICES V-1). It uses GJS and GNOME
libraries. You need Node.js only to build and test the TypeScript source.
The service needs Python 3.11 or later.

Install the JavaScript dependencies:

```sh
npm ci
```

You must also have these items:

- GNOME Shell 48, 49, 50, or 51 with `gjs`, `gnome-extensions`, and
  `glib-compile-schemas`.
- The Mutter devkit (`/usr/libexec/mutter-devkit`) for the nested shell. On
  Debian or Ubuntu, the package is `mutter-dev-bin`.
- [`uv`](https://docs.astral.sh/uv/) for the GNOME Extensions review scan.
- Python 3.11 or later with `venv`, for the service.

## Check a change

Before you open a pull request, run all the local checks:

```sh
npm run check          # type-check src/ and lint src/, tools/ and tests/
npm test               # bundle the pure modules and run the node unit tests
npm run build          # emit dist/<uuid>/ and lint it with the GNOME rules
npm run release:check  # validate metadata, sources and the dist/ tree
npm run review:check   # pack the ZIP and scan dist/ and the ZIP with Shexli
```

If you change the service, also run the checks in "Develop the service".
Then do the test in a nested shell. The procedure is below. PRACTICES T-3
makes this test necessary for each change to the Shell code.
Test each supported Shell version before release.

To make a release archive, run this command:

```sh
npm run pack
```

The command writes the archive to `build/releases/`. To do a test of the same
file that GNOME Extensions users get, install that archive:

```sh
gnome-extensions install --force build/releases/tokengrill@sh02sahil.github.io.shell-extension.zip
```

## How the build operates

The build does these steps:

- `tsc` writes one `.js` file for each `.ts` file into `dist/<uuid>/`. The tree
  in `dist/` is the same as the tree in `src/`. The build does not bundle or
  minify the code. Thus, reviewers read the same modules that are in the
  repository.

Then the build does these steps:

- `eslint --fix` with the GNOME rules then formats `dist/`. A second lint of
  `dist/` must show no errors.
- The build copies these files into `dist/`: the metadata, the license, the
  stylesheets, the schema, and the symbolic icons.
- Type errors do not stop the build. `npm run check` finds them.
- Each module in `src/` goes into the release. Thus, `extension.ts` or
  `prefs.ts` must import each module (PRACTICES P-6). Delete a module that is
  not in use.

The pack and review commands do these steps:

- `npm run pack` runs `check` and `build`. Then it runs `gnome-extensions pack`
  with an `--extra-source` for each item in `dist/` that the tool does not add
  automatically.
- `npm run release:check` examines these items:
  - The metadata keys, the UUID, the URL, `shell-version`, and `version-name`.
  - The sources: disabled type checks, subprocesses, and private development
    data.
  - The `dist/` tree: development files, icons that are not symbolic, `var`,
    and lines that are longer than 200 characters.
- `npm run review:check` packs the extension. Then it scans `dist/` and the
  upload ZIP with Shexli 0.2.1 and tree-sitter 0.25.2. The fixed tree-sitter
  version prevents a known problem in the dependency range of Shexli 0.2.1.
  Shexli 0.2.1 rejects GNOME Shell 51 as a future version (EGO-M-004). The
  Shexli on extensions.gnome.org does not, and the reviewers accept 51. Thus,
  the check accepts only this finding (PRACTICES T-2).

## Do a test in a nested shell

Use a separate data directory and a separate state directory. Thus, the nested
shell cannot change your real totals and history checkpoints. The script does
not start if only `XDG_DATA_HOME` is separate.

```sh
export XDG_DATA_HOME="$(mktemp -d)" XDG_STATE_HOME="$(mktemp -d)"
npm run install:local
npm run dev:shell
```

The extension needs a service. See "Run the extension against a local
service" below.

`npm run dev:shell` makes sure that the build is in `$XDG_DATA_HOME`. It also
makes sure that no other Token Grill UUID is installed. Then it starts
`gnome-shell --devkit --wayland` in `dbus-run-session`. Thus, the script does
not change your session or its windows. In the nested shell, the script does
these steps:

1. It enables Token Grill and waits for `State: ACTIVE`.
2. It disables Token Grill and waits for `State: INACTIVE`.
3. It enables Token Grill again and waits for `State: ACTIVE`.

During the test, look at the log in a different terminal:

```sh
journalctl -f -o cat /usr/bin/gnome-shell   # Shell processes
journalctl -f -o cat /usr/bin/gjs           # preferences process
```

The script also shows two values: a `_PID=` filter for the nested shell, and
the `DBUS_SESSION_BUS_ADDRESS` of the nested session. To control the nested
shell from a second terminal, export that address in it. Then do these steps:

1. Lock the nested shell:

   ```sh
   gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver --method org.gnome.ScreenSaver.Lock
   ```

2. Unlock the nested shell. Type your password in the nested window, or use
   the same call with `--method org.gnome.ScreenSaver.SetActive false`.
3. Open the preferences:

   ```sh
   gnome-extensions prefs tokengrill@sh02sahil.github.io
   ```

After each step, look for criticals, warnings, and objects that are not
released.

CAUTION: The nested shell uses the same dconf database as your desktop. If you
change a preference of Token Grill in the nested shell, the preference also
changes on your desktop. If you enable or disable an extension in the nested
shell, the extension also changes on your desktop.

CAUTION: Do not restore `org.gnome.shell enabled-extensions` through a
temporary list. The desktop Shell disables each extension that is not in the
list.

The devkit uses the GNOME Shell version that is installed on the computer. It
cannot show other Shell versions. On a Wayland session, a changed extension
loads only after you log out and log in again.

## Develop the service

The service is in `service/`. Use a virtual environment:

```sh
cd service
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
```

Run the checks in `service/`:

```sh
.venv/bin/pytest -q                 # unit tests; no network, no session bus
.venv/bin/pytest -q -m integration  # tests that need a real session bus
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/mypy src
```

The service has three runtime dependencies: `dbus-fast`, `httpx`, and
`secretstorage`. Each has a lower and an upper major bound. Do not add a
dependency that needs a compiler or PyGObject.

Tests that need a real credential or the network are marked `integration`.
Do not paste their output into issues, pull requests, or chats: it shows your
plan and your usage.

If you change `interface.xml`, copy the same text into `src/dbus/interface.ts`.
`npm test` compares the two files.

## Run the extension against a local service

The service file that `tokengrill setup` writes starts the Python of the
environment that ran it. Thus, set up from the development environment:

```sh
cd service
.venv/bin/tokengrill setup
.venv/bin/tokengrill status
```

Then start the nested shell as above. After you change the service code,
stop the running service (it exits 60 seconds after the last client leaves) or
run `pkill -f 'tokengrill run'`. The extension starts a new one when it needs
it. To remove the registration, run `.venv/bin/tokengrill uninstall`.

Use a separate `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` for
the test, as for the nested shell. Thus, the service does not change your real
accounts and history.

## Repository guide

The extension is in `src/`:

- `src/extension.ts` creates a `Runtime` (`src/runtime.ts`) in `enable()` and
  stops it in `disable()`. The runtime owns all objects that `enable()`
  creates.
- `src/client.ts` is the D-Bus client of the service. `src/dbus/interface.ts`
  holds the interface text.
- `src/prefs.ts` makes the preferences window from the pages in `src/prefs/`.
- `src/core/` contains code without Shell or GTK imports. Both processes and
  the unit tests use this code.
- `src/shell/` shows the panel indicator and the popup.

The service is in `service/src/tokengrill/`:

- `cli.py` has the commands. `service.py` runs the service.
- `dbus/` exports the interface. `core/` has the logic without I/O.
- `providers/` reads the credentials, the history, and the usage limits of
  each service.
- `storage/` keeps the accounts, the totals, and the checkpoints.
- `net/` is the one HTTP client.

The other directories contain these items:

- `resources/` contains the stylesheets and the original symbolic icons.
- `schemas/` contains the GSettings schema.
- `tests/unit/` contains the tests for the client, the policies, and the user
  interface of the extension.
- `service/tests/` contains the tests of the service.
- `tools/` contains the build, pack, install, and release scripts and the
  nested shell script. These files are not part of the release.

## Safety rules

Obey these rules for data:

- Do not commit credentials, bearer tokens, client secrets, or private keys.
- Do not attach a real prompt history or session log to an issue.
- Use test data that cannot sign in to a service.

Obey these rules for code:

- Keep the service hosts fixed and validated. Do not send credentials to a URL
  from a user. The extension makes no network request; the service does.
- Never return a token or a key over D-Bus, and never log one.
- Do not start subprocesses or helper scripts in the extension code.
- Do not add telemetry.
- Keep the cleanup symmetrical. After `enable()`, `disable()` must remove each
  object, signal, source, and task that Token Grill created or started.

## Add a service

A service must have a stable, read-only method to get the usage. You add it to
the Python service (`service/src/tokengrill/providers/`). Write down
these items for the service: the credential source, the network host, the
response limits, the behavior on failure, and the effect on privacy. Add test
data without personal data and normalizer tests before you add the user
interface.

Each service icon must be an original symbolic SVG (`*-symbolic.svg`). Do not
add, copy, or trace a logo of a different company (PRACTICES LE-3, LE-3a).

## AI-assisted contributions

We accept AI-assisted work when the contributor understands it, examines it,
and is responsible for it. Do not send large AI output without an explanation,
prompt transcripts, APIs that do not exist, or unnecessary defensive code. If
AI help had an effect on the implementation, tell us in the pull request.

## Make a release

1. Set the same version in `package.json`, `package-lock.json`, and the
   `version-name` key of `metadata.json`.
2. Add the changes for users to `CHANGELOG.md`.
3. Run all the checks in "Check a change" and in "Develop the service".
4. Do the test in a nested shell.
5. Set the same version in `service/src/tokengrill/__init__.py`, and publish
   the package to PyPI before the extension. The extension needs the
   service.
6. Upload the release only after the review of the previous version is
   complete (PRACTICES E-6).

## Release identity

`tokengrill@sh02sahil.github.io` is the permanent public UUID. A different UUID
makes a different GNOME extension. Users of the old UUID then get no updates.
