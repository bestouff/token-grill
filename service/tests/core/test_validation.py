import posixpath
from typing import cast

from tokengrill.core.validation import ExistingProviderPath, ProviderDraftPaths, validate_provider_draft

HOME = "/home/test"


def canonicalize(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("A path is required.")
    expanded = f"{HOME}/{trimmed[2:]}" if trimmed.startswith("~/") else trimmed
    if not expanded.startswith("/"):
        raise ValueError("Paths must be absolute or start with ~/.")
    return posixpath.normpath(expanded)


def draft(**overrides: str | None) -> ProviderDraftPaths:
    base: ProviderDraftPaths = {
        "id": "new-provider",
        "displayName": "Codex",
        "accountHome": "~/.codex",
        "authFileOverride": None,
        "sessionsDirectoryOverride": None,
    }
    return cast(ProviderDraftPaths, {**base, **overrides})


def test_a_new_provider_with_generated_defaults_and_a_unique_home_is_valid() -> None:
    assert validate_provider_draft(draft(), [], canonicalize) == {"valid": True, "errors": {}}


def test_an_empty_display_name_marks_only_the_display_name_field() -> None:
    result = validate_provider_draft(draft(displayName="  "), [], canonicalize)
    assert result["valid"] is False
    assert result["errors"] == {"displayName": "required"}


def test_empty_and_relative_account_homes_mark_the_account_home_field() -> None:
    for home in ["", "relative/account"]:
        result = validate_provider_draft(draft(accountHome=home), [], canonicalize)
        assert result["valid"] is False
        assert result["errors"]["accountHome"]
        assert "displayName" not in result["errors"]


def test_expanded_equivalent_account_homes_are_duplicates() -> None:
    providers: list[ExistingProviderPath] = [{"id": "existing", "accountHome": "/home/test/.codex"}]
    result = validate_provider_draft(draft(accountHome="~/.codex"), providers, canonicalize)
    assert result["errors"] == {"accountHome": "duplicate-home"}


def test_editing_a_provider_excludes_its_own_account_home() -> None:
    providers: list[ExistingProviderPath] = [{"id": "existing", "accountHome": "/home/test/.codex"}]
    result = validate_provider_draft(draft(id="existing"), providers, canonicalize)
    assert result == {"valid": True, "errors": {}}


def test_optional_overrides_identify_their_own_invalid_fields() -> None:
    result = validate_provider_draft(
        draft(authFileOverride="auth.json", sessionsDirectoryOverride="sessions"), [], canonicalize
    )
    assert result["errors"] == {"authFileOverride": "not-absolute", "sessionsDirectoryOverride": "not-absolute"}


def test_correcting_every_invalid_field_clears_stale_errors() -> None:
    invalid = validate_provider_draft(draft(displayName="", accountHome="relative"), [], canonicalize)
    corrected = validate_provider_draft(draft(displayName="Work", accountHome="~/.codex-work"), [], canonicalize)
    assert invalid["valid"] is False
    assert corrected == {"valid": True, "errors": {}}


def test_credential_and_history_locations_do_not_need_to_exist() -> None:
    result = validate_provider_draft(
        draft(
            accountHome="/does/not/exist",
            authFileOverride="/does/not/exist/auth.json",
            sessionsDirectoryOverride="/does/not/exist/sessions",
        ),
        [],
        canonicalize,
    )
    assert result == {"valid": True, "errors": {}}
