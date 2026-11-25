"""Which Kiro failures depend only on the stored credentials."""

from tokengrill.core.errors import ServiceError

# Failures that depend only on the stored credentials: the account behind the token, or refresh
# material the service has already refused.
PERSISTENT_CODES = frozenset({"unsupported-account", "auth-expired"})


def kiro_usage_error(error: BaseException) -> BaseException:
    """Kiro answers GetUsageLimits with 403 FEATURE_NOT_SUPPORTED when the signed-in account has no Kiro
    usage (for example a user removed from the subscription whose Identity Center login still works). The
    token itself is fine, so the error gets its own code and message."""
    if (
        isinstance(error, ServiceError)
        and error.params.get("status") == "403"
        and error.params.get("reason") == "FEATURE_NOT_SUPPORTED"
    ):
        return ServiceError("unsupported-account", "kiro.no-usage-account", **error.params)
    return error


class KiroRejectedTokens:
    """Remembers failures that cannot change until kiro-cli's stored credentials change, so a rejected
    token is not sent again on every scheduled refresh. Entries are keyed by account and by a fingerprint
    of the stored credentials, so whatever kiro-cli holds next is always checked."""

    def __init__(self) -> None:
        self._entries: dict[str, tuple[str, ServiceError]] = {}

    def get(self, instance_id: str, fingerprint: str) -> ServiceError | None:
        entry = self._entries.get(instance_id)
        return entry[1] if entry is not None and entry[0] == fingerprint else None

    def remember(self, instance_id: str, fingerprint: str, error: BaseException) -> bool:
        if not isinstance(error, ServiceError) or error.code not in PERSISTENT_CODES:
            return False
        self._entries[instance_id] = (fingerprint, error)
        return True

    def forget(self, instance_id: str) -> None:
        self._entries.pop(instance_id, None)
