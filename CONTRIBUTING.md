# Contributing to Token Grill

Thanks for helping make Token Grill more reliable. Small, well-tested changes
are easiest to review.

## Before you start

Token Grill targets GNOME Shell 50. Runtime code uses GJS and GNOME libraries;
Node.js is needed only to build and test the TypeScript source.

Install the JavaScript dependencies:

```sh
npm ci
```

You will also need `gjs`, `gnome-extensions`, `glib-compile-schemas`, and GNOME
Shell 50. Kiro tests that access SQLite need the Gda 5.0 introspection package.

## Check a change

Run the complete local check before opening a pull request:

```sh
npm run check
npm test
npm run build
npm run release:check
```

Build a release-format archive with:

```sh
npm run pack
```

The archive is written to `build/releases/`. Install that archive when testing
the same path a GNOME Extensions user receives:

```sh
gnome-extensions install --force build/releases/tokengrill@sh02sahil.github.io.shell-extension.zip
```

For interactive UI work, `npm run install:local` installs the current build and
`npm run dev:shell` starts an isolated Mutter development session. The devkit
uses the GNOME Shell version installed on the machine; it does not emulate older
Shell releases.

## Repository guide

- `src/extension.ts` owns the extension lifecycle.
- `src/prefs.ts` builds the preferences window.
- `src/providers/` reads provider credentials, history, and quota APIs.
- `src/storage/` stores aggregates and parser checkpoints.
- `src/shell/` renders the panel and popup.
- `resources/` contains styles, pricing, and attributed provider marks.
- `tests/unit/` covers parsing, normalization, policy, and UI regressions.
- `tools/` contains build and release validation scripts; none ship at runtime.

## Safety rules

- Never commit provider credentials, bearer tokens, client secrets, or private
  keys.
- Never attach real prompt history or session logs to an issue.
- Use synthetic fixtures that cannot authenticate to a service.
- Keep provider endpoints fixed and validated. Do not send credentials to a
  user-supplied URL.
- Keep runtime code free of subprocesses and external helper scripts.
- Do not add telemetry.
- Preserve cleanup symmetry: anything created, connected, scheduled, or started
  after `enable()` must be destroyed, disconnected, removed, or cancelled in
  `disable()`.

## Adding a provider

A provider must have a stable, read-only way to discover usage. Document its
credential source, network destination, response limits, failure behavior, and
privacy impact. Add sanitized fixtures and normalization tests before adding UI.

Provider logos need an official source, an exact checksum, and an entry in
`NOTICE.md`. They must identify the provider without becoming Token Grill's own
branding.

## AI-assisted contributions

AI-assisted work is welcome when the contributor understands it, checks it, and
accepts responsibility for it. Do not submit unexplained bulk output, prompt
transcripts, invented APIs, or redundant defensive code. Describe material AI
assistance in the pull request when it shaped the implementation.

## Release identity

`tokengrill@sh02sahil.github.io` is the permanent public UUID. Changing it would
create a different GNOME extension and strand existing users.
