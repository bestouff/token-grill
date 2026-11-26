# tokengrill

The Python service behind the Token Grill GNOME Shell extension. It reads the
sign-ins of your AI coding tools, gets the usage limits of Codex, Claude, Kiro,
Antigravity, GitHub Copilot, OpenCode Go, Kimi Code, and Cursor accounts and the
DeepSeek balance, and serves them over D-Bus. The extension shows them in the
GNOME top bar.

## Install

You need Python 3.11 or later and a D-Bus session (a GNOME desktop has both).

```sh
pipx install tokengrill && ~/.local/bin/tokengrill setup
```

If you do not have pipx, run `sudo apt install pipx` (Ubuntu, Debian) or
`sudo dnf install pipx` (Fedora) first. With uv, run
`uv tool install tokengrill && ~/.local/bin/tokengrill setup`.

`setup` writes one D-Bus service file. After that, the session bus starts the
service when the extension calls it. You do not start it yourself. To update, run
`pipx upgrade tokengrill`.

## Commands

| Command | What it does |
| ------- | ------------ |
| `tokengrill setup` | Writes the D-Bus service file and asks the session bus to read it. |
| `tokengrill uninstall [--purge]` | Removes the service file. With `--purge`, it asks if it should also delete the accounts, the history, and the pasted API keys; it stops the running service first. |
| `tokengrill status [--json] [--refresh]` | Starts the service if needed and prints the accounts and their limits. `--refresh` refreshes all accounts first and waits. `--json` prints the raw state. |
| `tokengrill version` | Prints the package version and the D-Bus API version. |
| `tokengrill run` | Serves the D-Bus interface. The D-Bus service file runs this. |

## D-Bus

- Bus name: `io.github.sh02sahil.TokenGrill` on the session bus.
- Object path: `/io/github/sh02sahil/TokenGrill`.
- Interface: `io.github.sh02sahil.TokenGrill1`. Its full text is
  [`src/tokengrill/dbus/interface.xml`](https://github.com/sh02sahil/token-grill/blob/main/service/src/tokengrill/dbus/interface.xml).

Structured data crosses as JSON strings with `"schema": 1`. No method or signal
returns a token, a key, or the content of a file.

The scheduler, the history scans, and the notification decisions run only
while the Token Grill extension is connected. The service exits 60 seconds
after the last extension or preferences client has left.

## Files

| File | Content |
| ---- | ------- |
| `$XDG_DATA_HOME/dbus-1/services/io.github.sh02sahil.TokenGrill.service` | The D-Bus service file (`setup` writes it). |
| `$XDG_CONFIG_HOME/token-grill/config.json` | The accounts and the settings (mode 0600). |
| `$XDG_CONFIG_HOME/token-grill/imported-0.4.json` | A backup of the accounts that the service imported once from Token Grill 0.4. |
| `$XDG_DATA_HOME/token-grill/history-v1.json` | The daily token totals. |
| `$XDG_STATE_HOME/token-grill/*-v1.json` | The balances, the history checkpoints, the diagnostics, the notification state, and the last readings. |

These files hold no credentials, prompts, or responses. A pasted DeepSeek key
is in the GNOME keyring.

## Privacy

The service reads the credentials that the tools of each service stored on this
computer, read-only. It never unlocks a keyring or exchanges a Codex or Claude
refresh token itself. For an expired Claude Code sign-in, it runs the installed
`claude auth status` with the account's `CLAUDE_CONFIG_DIR`; Claude Code handles
renewal and writes its own replacement credentials. The service discards the
command's output, limits it to 30 seconds, and rereads the credentials. Failed
attempts are limited to one per file every five minutes. The CLI's requests
use its own network configuration, with nonessential traffic disabled.

The service's HTTP client sends a credential only to its own service, over HTTPS,
with no redirects, and only to the hosts in the table in the
[main README](https://github.com/sh02sahil/token-grill/blob/main/README.md#privacy-and-network-access). It has no telemetry.

## Uninstall

```sh
tokengrill uninstall
pipx uninstall tokengrill
```

Add `--purge` to the first command to also delete the accounts, the history,
and the pasted API keys in the keyring. It stops the running service before
it deletes them. The keyring can ask to be unlocked.

## Develop

```sh
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q
.venv/bin/ruff check . && .venv/bin/mypy src
```

To test Claude usage with a real sign-in, set `TOKENGRILL_LIVE_CLAUDE_HOME`
to the Claude Code config directory and run
`.venv/bin/pytest -q -m integration tests/providers/test_claude.py`.
This may ask the installed Claude CLI to renew expired credentials. The test
does not print tokens, account details, or usage figures.

Refer to [CONTRIBUTING.md](https://github.com/sh02sahil/token-grill/blob/main/CONTRIBUTING.md). The license is GPL-3.0-or-later.
