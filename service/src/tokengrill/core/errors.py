"""Collector failures: a code, a message id and string params, never rendered text."""

from tokengrill.core.types import ErrorCode, ErrorInfo, Recovery

RECOVERY: dict[ErrorCode, Recovery] = {
    "auth-missing": "reauthenticate",
    "auth-expired": "reauthenticate",
    "auth-invalid": "reauthenticate",
    "unsupported-account": "reauthenticate",
    "dependency": "none",
    "permission": "edit-provider",
    "offline": "retry",
    "timeout": "retry",
    "rate-limited": "retry",
    "http": "retry",
    "response-shape": "edit-provider",
    "local-history": "retry",
    "internal": "retry",
}

TRANSIENT_CODES: frozenset[ErrorCode] = frozenset({"offline", "timeout", "rate-limited"})


class ServiceError(Exception):
    def __init__(self, code: ErrorCode, message_id: str, **params: str) -> None:
        super().__init__(message_id)
        self.code: ErrorCode = code
        self.message_id = message_id
        self.params: dict[str, str] = dict(params)

    def info(self) -> ErrorInfo:
        return {
            "code": self.code,
            "messageId": self.message_id,
            "params": dict(self.params),
            "recovery": RECOVERY[self.code],
        }


def http_error(status: int, reason: str | None) -> ServiceError:
    code: ErrorCode = "http"
    if status in (401, 403):
        code = "auth-invalid"
    elif status == 429:
        code = "rate-limited"
    if reason:
        return ServiceError(code, "net.http-status", status=str(status), reason=reason)
    return ServiceError(code, "net.http-status-bare", status=str(status))


class InvalidRequest(ValueError):
    """A request from a client that cannot be carried out; the D-Bus layer reports it as InvalidArgs."""


class NoSignInCommand(Exception):
    """The account's app has no CLI login that Token Grill can point at this account."""
