"""Checks of an account draft before it is saved; the codes are the 0.4.1 ones."""

from collections.abc import Callable
from typing import Literal, NotRequired, TypedDict

ProviderValidationCode = Literal["required", "not-absolute", "duplicate-home"]


class ProviderValidationErrors(TypedDict, total=False):
    displayName: ProviderValidationCode
    accountHome: ProviderValidationCode
    authFileOverride: ProviderValidationCode
    sessionsDirectoryOverride: ProviderValidationCode


class ProviderValidationResult(TypedDict):
    valid: bool
    errors: ProviderValidationErrors


class ProviderDraftPaths(TypedDict):
    id: NotRequired[str]
    displayName: str
    accountHome: str
    authFileOverride: NotRequired[str | None]
    sessionsDirectoryOverride: NotRequired[str | None]


class ExistingProviderPath(TypedDict):
    id: str
    accountHome: str


def _path_format_error(value: str) -> ProviderValidationCode | None:
    trimmed = value.strip()
    if not trimmed:
        return "required"
    if not trimmed.startswith(("~/", "/")):
        return "not-absolute"
    return None


def _optional_path_error(value: str | None) -> ProviderValidationCode | None:
    return _path_format_error(value) if value is not None and value.strip() else None


def validate_provider_draft(
    draft: ProviderDraftPaths,
    providers: list[ExistingProviderPath],
    canonicalize: Callable[[str], str],
) -> ProviderValidationResult:
    errors: ProviderValidationErrors = {}

    if not draft["displayName"].strip():
        errors["displayName"] = "required"

    home_error = _path_format_error(draft["accountHome"])
    if home_error:
        errors["accountHome"] = home_error
    else:
        home = canonicalize(draft["accountHome"])
        draft_id = draft.get("id")
        if any(p["id"] != draft_id and canonicalize(p["accountHome"]) == home for p in providers):
            errors["accountHome"] = "duplicate-home"

    auth_error = _optional_path_error(draft.get("authFileOverride"))
    if auth_error:
        errors["authFileOverride"] = auth_error
    sessions_error = _optional_path_error(draft.get("sessionsDirectoryOverride"))
    if sessions_error:
        errors["sessionsDirectoryOverride"] = sessions_error

    return {"valid": not errors, "errors": errors}
