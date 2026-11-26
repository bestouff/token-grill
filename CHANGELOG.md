# Changelog

## Unreleased

- When a Claude Code access token expires, the service runs `claude auth status`
  for that account and rereads its credentials. Claude Code handles renewal and
  saves the replacement tokens. This keeps local usage readings current when
  you mostly use Claude on another machine. Failed attempts are limited to one
  per credentials file every five minutes. A revoked login still needs sign-in.

## 0.5.0

- Token Grill has two parts now: the extension and a small service,
  `tokengrill`, from PyPI. The service reads the sign-ins and gets the usage
  limits. The extension shows them. The sign-ins, the hosts, and the privacy
  rules do not change.
- One-time setup: run `pipx install tokengrill && ~/.local/bin/tokengrill
  setup`. Until you do, the popup and the preferences show this command with a
  **Copy** button. Without pipx, use `uv tool install tokengrill` or install
  pipx first (`sudo apt install pipx`, `sudo dnf install pipx`).
- `tokengrill status` shows the accounts and the limits in a terminal.
  `tokengrill uninstall` removes the service registration.
- The first time that the service starts, it imports your accounts once from
  the 0.4 settings. It keeps a backup in
  `~/.config/token-grill/imported-0.4.json`. The accounts now live in
  `~/.config/token-grill/config.json`.
- After you update, log out and log in once. Until then, the Shell runs 0.4
  and keeps its accounts and totals. Preferences already show the accounts in
  the service, but they do not change the 0.4 settings. After the login, the
  Shell empties the 0.4 account list.
- If you go back to 0.4.1, it shows no accounts, because the accounts are in
  the new file. Add them again, or run this command to restore the accounts
  that the service imported:

  ```sh
  gsettings --schemadir ~/.local/share/gnome-shell/extensions/tokengrill@sh02sahil.github.io/schemas \
      set org.gnome.shell.extensions.tokengrill provider-instances-json \
      "$(python3 -c 'import json, pathlib; print(json.loads((pathlib.Path.home() / ".config/token-grill/imported-0.4.json").read_text())["providerInstancesJson"])')"
  ```

  The service imports only once. If you change the accounts in 0.4.1 and
  update again, add the changes again in 0.5. The 0.4 settings keep them.
- The journal diagnostics switch is no longer in the extension. The setting
  (`journalDiagnostics`) now belongs to the service. The README shows the
  command that sets it.
- Kiro and Cursor no longer need the Gda library. The extension no longer
  needs libsecret.
- A history scan that stops in the middle of a file, for example at a screen
  lock, no longer counts the lines of that file two times.
- With a 12-hour clock, the popup no longer shows a wide gap before a
  one-digit hour, as in "Updated 9:29 AM".
- In the top bar, the color dot of an account sits beside its bars, or beside
  its rings when three limits are shown. Before, it sat below them and moved
  the reading out of line with the rest of the top bar.
- OpenCode Go: the rolling limit shows no usage pace. The service does not
  report the length of that window, and Token Grill no longer assumes five
  hours.
- `tokengrill uninstall --purge` names each folder that it could not delete
  and exits with an error, instead of reporting that everything is deleted.

## 0.4.1

- Token Grill also operates with GNOME Shell 48, 49, and 51.
- Preferences -> General -> Position puts Token Grill on the left or the right
  side of the top bar.
- The popup and the top bar keep the last reading of each account after a
  lock, a restart, or an update. They show its time until a refresh works.
- Sign In Again in a Terminal: when a sign-in is missing or expired, the popup
  opens your terminal with the login command of that account and its home.
  The hint names the home variable for accounts outside the default home.
- Usage Pace for every service with limits: a line in the popup and an icon in
  the top bar show whether a limit is used faster or slower than its period
  passes. Turn it on for each account in Preferences.
- Add Account accepts a home folder that Token Grill did not find, such as a
  new or signed-out account. Before, only found accounts could be added.
- Cursor: the monthly total and the two pools, Cursor models and other models.
  Its icon is a hexagon with a pointer.
  Token Grill reads the sign-in of the Cursor CLI (`agent login`) or of the
  Cursor app. The Cursor app sign-in needs the Gda 5.0 SQLite library, as Kiro
  does. If the Cursor app encrypts its sign-in, Token Grill does not read it;
  use the Cursor CLI sign-in.
- Texts use plain characters: " - " separates parts, such as "Weekly - Fable",
  and "..." ends a button that opens a dialog. If you showed a Claude model
  limit such as "Weekly - Fable" in the top bar, check it again in the popup.

## 0.4.0

New services:

- GitHub Copilot: the monthly allowance. Token Grill reads the GitHub sign-in
  of the GitHub CLI, the Copilot CLI, or OpenCode. On plans with AI Credits, the
  popup shows the credits used and the credits in the plan.
- OpenCode Go: the 5-hour, weekly, and monthly limits.
- DeepSeek: the prepaid balance. The top bar shows the balance as a meter. The
  meter is full after each top-up.
- Kimi Code: the 5-hour, weekly, and monthly limits.
- OpenCode is an app that you can add accounts from. A Codex or Claude sign-in
  in OpenCode joins the Codex or Claude service as an account "via OpenCode".

Top bar and popup:

- The top bar shows one entry for each service. Each entry shows all the
  accounts of the service that you selected for the top bar.
- Each account can show more than one limit. In the ring style, the rings of
  one account are inside each other.
- To select the limits for the top bar, check them in the popup. Use "Pick
  Automatically" to let Token Grill show the limit with the most usage.
- Click a service in the top bar to open the popup on that service.
- The popup can show the accounts of a service as buttons or as a list.
- Rings and bars use the text color of the top bar and the popup, so they are
  easy to read with all accent colors. A limit with less than 20% remaining
  turns yellow (amber in the light style). A limit with less than 5% remaining
  turns red. All the colors have a contrast of at least 4.5:1 in the light
  style and in the dark style.

Notifications:

- Only the limits that the top bar shows send alerts. Each limit has its own
  alert steps.
- An alert shows the service, the account, the limit, the remaining or used
  percentage, and the reset time.
- A DeepSeek account sends one alert when its balance drops below the warning
  amount that you set.

Preferences:

- **Add Account** starts with the app that you sign in with. Token Grill finds
  the signed-in accounts of that app.
- **Discover** finds the accounts of all the supported apps. You select the
  accounts to add and show in the top bar.
- If you add an account that you added before from a different app, Token
  Grill shows a warning.
- Each account has its own page. Changes apply immediately.
- You can select a custom color for an account.
- You can paste a DeepSeek API key. Token Grill keeps the key in the GNOME
  keyring, not in the settings.
- **Save Diagnostics Report** on the **Data** page saves a report for a bug
  report. The report does not contain tokens, keys, e-mail addresses, account
  names, or your home folder.

Changes in behavior:

- If you select an account in the popup, the top bar does not change. To change
  the top bar, check the limits in the popup.
- When you upgrade from 0.3, the account that the top bar showed keeps its
  limit in the top bar. If the service does not report that limit, the account
  uses Pick Automatically. The other accounts are not in the top bar until you
  check their limits.

Bug fixes:

- Claude alerts operate again. Before this fix, each refresh started the alert
  steps of a Claude limit again.

If you go back to 0.3, Token Grill 0.3 removes the accounts of the new
services. All the other accounts show in the top bar again.

## 0.3.2

Bug fixes:

- Claude accounts show their model-scoped weekly limit, such as the Fable
  limit, as a limit of its own.
- The Claude sign-in hint names `claude auth login`.
- The Live Quota and Local History switches are directly below the identity
  fields of the account dialog.
- The Antigravity keyring check never asks to unlock a locked keyring. A
  locked keyring counts as unavailable.
- The popup no longer keeps the replaced account mark in memory after each
  refresh.

## 0.3.1

Bug fixes:

- The Antigravity keyring check removes its timer as soon as Token Grill is disabled or the
  preferences window closes.

## 0.3.0

- The popup and the preferences window use the standard GNOME interface. They
  obey the light style, the dark style, and high contrast.
- New original symbolic icons replace the logos of the services.
- Notifications have a new layout.

Bug fixes:

- Antigravity accounts with an agy sign-in show their usage limits again.
- Kiro accounts in regions other than us-east-1 use the correct region.
- Token Grill does not cause delays to the desktop when it reads files.
- The history scan keeps a line that the service writes at the same time.
- Refresh All Accounts operates correctly when automatic updates are off.
- Rate limits show as a normal error.
- The expiry times of reset credits obey the 12-hour or 24-hour clock
  preference.

## 0.2.0

- Token Grill monitors Antigravity accounts.
