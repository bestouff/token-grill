"""Checks and builds the account lists that AddAccounts, UpdateAccount and ValidateAccount produce."""

from tokengrill.core.config import EDITABLE_FIELDS, default_app, draft_provider, normalize_provider, provider_kind
from tokengrill.core.errors import InvalidRequest
from tokengrill.core.json_util import is_record
from tokengrill.core.order import reorder_providers
from tokengrill.core.paths import expand_path
from tokengrill.core.types import ProviderInstance
from tokengrill.core.validation import (
    ExistingProviderPath,
    ProviderDraftPaths,
    ProviderValidationErrors,
    validate_provider_draft,
)


def _optional_text(entry: dict[str, object], key: str) -> str | None:
    value = entry.get(key)
    return value if isinstance(value, str) else None


def validation_errors(
    draft: ProviderDraftPaths, others: list[ProviderInstance], kind: str, app: str | None
) -> ProviderValidationErrors:
    """As 0.4.1: two apps can share a home (Claude Code and DeepSeek in ~/.claude), so only the same app counts."""
    peers: list[ExistingProviderPath] = [
        {"id": other["id"], "accountHome": other["accountHome"]}
        for other in others
        if other["accountHome"] and other["kind"] == kind and app in (None, other["app"])
    ]
    errors = validate_provider_draft(draft, peers, expand_path)["errors"]
    # A key pasted into the keyring has no home.
    if app == "keyring" and draft["accountHome"] == "":
        errors.pop("accountHome", None)
    return errors


def draft_paths(entry: dict[str, object], default_name: str, account_id: str | None = None) -> ProviderDraftPaths:
    name = entry.get("displayName")
    draft: ProviderDraftPaths = {
        "displayName": name if isinstance(name, str) else default_name,
        "accountHome": _optional_text(entry, "accountHome") or "",
        "authFileOverride": _optional_text(entry, "authFileOverride"),
        "sessionsDirectoryOverride": _optional_text(entry, "sessionsDirectoryOverride"),
    }
    if account_id is not None:
        draft["id"] = account_id
    return draft


def validate_draft(existing: list[ProviderInstance], draft: object) -> ProviderValidationErrors:
    """The field errors of a draft; kind and app narrow the duplicate-home check when the draft names them."""
    if not is_record(draft):
        raise InvalidRequest("the draft must be an object")
    account_id = draft.get("id")
    current = next((a for a in existing if a["id"] == account_id), None)
    kind = draft.get("kind") if isinstance(draft.get("kind"), str) else (current["kind"] if current else "")
    app = draft.get("app") if isinstance(draft.get("app"), str) else (current["app"] if current else None)
    return validation_errors(
        draft_paths(draft, current["displayName"] if current else "x", current["id"] if current else None),
        existing,
        str(kind),
        app if isinstance(app, str) else None,
    )


def with_new_accounts(
    existing: list[ProviderInstance], entries: object
) -> tuple[list[ProviderInstance], dict[str, ProviderValidationErrors]]:
    """The list with the drafts appended and renumbered, or the field errors by draft index; nothing is half added."""
    if not isinstance(entries, list) or not entries:
        raise InvalidRequest("accounts must be a non-empty list")
    added: list[ProviderInstance] = []
    errors: dict[str, ProviderValidationErrors] = {}
    for index, entry in enumerate(entries):
        kind = provider_kind(entry.get("kind")) if is_record(entry) else None
        if kind is None or not is_record(entry):
            raise InvalidRequest(f"account {index} is not a valid draft")
        app = entry.get("app")
        found = validation_errors(
            draft_paths(entry, "Account"), [*existing, *added], kind, app if isinstance(app, str) else default_app(kind)
        )
        if found:
            errors[str(index)] = found
            continue
        account = draft_provider(entry)
        if account is None:
            raise InvalidRequest(f"account {index} is not a valid draft")
        added.append(account)
    if errors:
        return existing, errors
    combined = [*existing, *added]
    return reorder_providers(combined, [account["id"] for account in combined]), {}


def with_updated_account(
    existing: list[ProviderInstance], entry: object
) -> tuple[list[ProviderInstance], ProviderValidationErrors]:
    if not is_record(entry):
        raise InvalidRequest("the account must be an object")
    current = next((account for account in existing if account["id"] == entry.get("id")), None)
    if current is None:
        raise InvalidRequest("unknown account")
    changes = {key: value for key, value in entry.items() if key in EDITABLE_FIELDS}
    merged = normalize_provider({**current, **changes})
    if not merged:
        raise InvalidRequest("the account is not valid")
    updated = merged[0]
    # The raw name is checked: normalizing turns an empty one into the service's label.
    errors = validation_errors(
        draft_paths({**current, **changes}, current["displayName"], current["id"]),
        existing,
        updated["kind"],
        updated["app"],
    )
    if errors:
        return existing, errors
    replaced = [updated if account["id"] == updated["id"] else account for account in existing]
    return reorder_providers(replaced, [account["id"] for account in replaced]), {}
