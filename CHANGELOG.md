# Changelog

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
