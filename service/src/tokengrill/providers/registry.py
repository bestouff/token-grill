"""The collectors by service kind."""

from tokengrill.core.types import ProviderKind
from tokengrill.providers.base import Collector


def create_collectors() -> dict[ProviderKind, Collector]:
    """Collectors hold only in-memory token caches, so they are released by dropping them."""
    return {}
