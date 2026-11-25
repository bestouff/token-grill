"""The GitHub CLI's hosts.yml: the active user of github.com, and its token when
gh was told to store it in plain text instead of the keyring."""

import re
from typing import TypedDict

_HOST = "github.com:"
# Only the host's own keys, indented one level; per-user entries sit deeper.
_KEY = re.compile(r"^ {4}(user|oauth_token):\s*(\S+)\s*$")


class GhHosts(TypedDict):
    user: str | None
    token: str | None


def parse_gh_hosts(text: str) -> GhHosts:
    in_host = False
    user: str | None = None
    token: str | None = None
    for line in text.split("\n"):
        if not line.startswith(" "):
            in_host = line.strip() == _HOST
            continue
        match = _KEY.match(line) if in_host else None
        if match is None:
            continue
        if match.group(1) == "user":
            user = match.group(2)
        else:
            token = match.group(2)
    return {"user": user, "token": token}
