import re

from tokengrill.core.errors import RECOVERY, TRANSIENT_CODES, ServiceError, http_error
from tokengrill.core.messages import AREAS, MESSAGES
from tokengrill.core.types import ACCENTS, BALANCE_KEY, EMPTY_TOTALS, empty_snapshot


def test_info_carries_code_id_params_and_recovery() -> None:
    error = ServiceError("auth-expired", "codex.auth-expired")
    assert error.info() == {
        "code": "auth-expired",
        "messageId": "codex.auth-expired",
        "params": {},
        "recovery": "reauthenticate",
    }


def test_params_are_kept() -> None:
    error = ServiceError("auth-missing", "config.no-credentials", path="~/x")
    assert error.params == {"path": "~/x"}
    assert error.info()["params"] == {"path": "~/x"}


def test_http_error_maps_statuses() -> None:
    assert http_error(401, None).code == "auth-invalid"
    assert http_error(403, "x").code == "auth-invalid"
    assert http_error(429, None).code == "rate-limited"
    assert http_error(500, "Server").params == {"status": "500", "reason": "Server"}
    assert http_error(500, "Server").message_id == "net.http-status"
    assert http_error(500, None).message_id == "net.http-status-bare"
    assert http_error(500, None).params == {"status": "500"}


def test_recovery_table_and_transient_codes() -> None:
    assert RECOVERY["dependency"] == "none"
    assert RECOVERY["permission"] == "edit-provider"
    assert RECOVERY["offline"] == "retry"
    assert TRANSIENT_CODES == {"offline", "timeout", "rate-limited"}


def test_every_message_is_ascii_and_has_a_known_area() -> None:
    for key, text in MESSAGES.items():
        assert text.isascii() and key.split(".")[0] in AREAS
        assert re.fullmatch(r"[a-z]+(-[a-z]+)*\.[a-z0-9]+(-[a-z0-9]+)*", key), key


def test_service_error_ids_used_by_the_service_exist() -> None:
    for key in ("service.internal", "net.offline", "net.http-status", "codex.auth-expired"):
        assert key in MESSAGES


def test_empty_snapshot_has_no_string_error_and_a_pace() -> None:
    snapshot = empty_snapshot("codex-1")
    assert "error" not in snapshot
    assert snapshot["errorInfo"] is None and snapshot["pace"] is None
    assert snapshot["totals"] == EMPTY_TOTALS and snapshot["totals"] is not EMPTY_TOTALS
    assert BALANCE_KEY == "balance" and "blue" in ACCENTS
