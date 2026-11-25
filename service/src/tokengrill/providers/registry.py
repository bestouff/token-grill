"""The collectors by service kind."""

from tokengrill.core.types import ProviderKind
from tokengrill.providers.antigravity.collector import AntigravityCollector
from tokengrill.providers.base import Collector
from tokengrill.providers.claude.collector import ClaudeCollector
from tokengrill.providers.codex.collector import CodexCollector
from tokengrill.providers.copilot.collector import CopilotCollector
from tokengrill.providers.deepseek.collector import DeepSeekCollector
from tokengrill.providers.kimi.collector import KimiCollector
from tokengrill.providers.kiro.collector import KiroCollector
from tokengrill.providers.opencode_go.collector import OpenCodeGoCollector


def create_collectors() -> dict[ProviderKind, Collector]:
    """Collectors hold only in-memory token caches, so they are released by dropping them."""
    return {
        "antigravity": AntigravityCollector(),
        "claude": ClaudeCollector(),
        "codex": CodexCollector(),
        "copilot": CopilotCollector(),
        "deepseek": DeepSeekCollector(),
        "kimi": KimiCollector(),
        "kiro": KiroCollector(),
        "opencode-go": OpenCodeGoCollector(),
    }
