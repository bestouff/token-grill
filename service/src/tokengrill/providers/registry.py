"""The collectors by service kind."""

from tokengrill.core.types import ProviderKind
from tokengrill.providers.base import Collector
from tokengrill.providers.claude.collector import ClaudeCollector
from tokengrill.providers.codex.collector import CodexCollector
from tokengrill.providers.kiro.collector import KiroCollector


def create_collectors() -> dict[ProviderKind, Collector]:
    """Collectors hold only in-memory token caches, so they are released by dropping them."""
    return {"claude": ClaudeCollector(), "codex": CodexCollector(), "kiro": KiroCollector()}
