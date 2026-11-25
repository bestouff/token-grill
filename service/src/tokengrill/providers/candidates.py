"""Accounts that could be added from an app, and whether each is new, already there, the same plan as
another account, or nothing Token Grill can track.

A candidate carries only what the preferences show; it never holds a token, a key or an e-mail address.
"""

from typing import Literal, TypedDict

from tokengrill.core.config import provider_label
from tokengrill.core.types import AccountApp, ProviderInstance, ProviderKind
from tokengrill.providers.identity import AccountIdentity, duplicate_of, identity_from_open_code
from tokengrill.providers.opencode.entries import OpenCodeEntry, match_open_code_entry

CandidateStatus = Literal["ready", "already-added", "nothing-to-track", "uses-other-app"]


class Candidate(TypedDict):
    # None for an OpenCode key that reaches no service Token Grill tracks.
    kind: ProviderKind | None
    app: AccountApp
    accountHome: str
    label: str
    status: CandidateStatus
    # The id of an account already added on the same plan.
    duplicateOf: str | None


_STATUS_ORDER: dict[CandidateStatus, int] = {
    "ready": 0,
    "already-added": 1,
    "uses-other-app": 2,
    "nothing-to-track": 3,
}


def by_status(candidates: list[Candidate]) -> list[Candidate]:
    return sorted(candidates, key=lambda candidate: _STATUS_ORDER[candidate["status"]])


def open_code_candidates(
    entries: dict[str, OpenCodeEntry],
    configured: list[ProviderInstance],
    identities: dict[str, AccountIdentity | None],
    open_code_home: str,
) -> list[Candidate]:
    """OpenCode keeps one sign-in per service, so a service added from OpenCode is added once."""
    candidates: list[Candidate] = []
    for entry_id, entry in entries.items():
        match = match_open_code_entry(entry_id, entry)
        if match["status"] == "nothing-to-track":
            candidates.append(
                {
                    "kind": None,
                    "app": "opencode",
                    "accountHome": open_code_home,
                    "label": entry_id,
                    "status": "nothing-to-track",
                    "duplicateOf": None,
                }
            )
            continue
        kind = match["kind"]
        added = any(item["kind"] == kind and item["app"] == "opencode" for item in configured)
        other_app = match["status"] == "uses-other-app"
        status: CandidateStatus = "uses-other-app" if other_app else "already-added" if added else "ready"
        candidates.append(
            {
                "kind": kind,
                "app": "opencode",
                "accountHome": open_code_home,
                "label": provider_label(kind),
                "status": status,
                "duplicateOf": None
                if other_app or added
                else duplicate_of(identity_from_open_code(entry_id, entry), identities),
            }
        )
    return by_status(candidates)
