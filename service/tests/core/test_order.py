from tokengrill.core.config import new_provider
from tokengrill.core.order import ordered_providers, reorder_providers
from tokengrill.core.types import ProviderInstance


def provider(provider_id: str, sort_order: int, enabled: bool = True) -> ProviderInstance:
    return {
        **new_provider("codex", "codex-cli", "~/.codex"),
        "id": provider_id,
        "sortOrder": sort_order,
        "enabled": enabled,
    }


def test_provider_order_is_stable_and_includes_disabled_accounts() -> None:
    providers = [provider("late", 9), provider("first", 0, False), provider("also-first", 0)]
    assert [item["id"] for item in ordered_providers(providers)] == ["first", "also-first", "late"]


def test_reordering_normalizes_sort_order_and_safely_appends_omitted_accounts() -> None:
    providers = [provider("a", 4), provider("b", 1, False), provider("c", 8)]
    reordered = reorder_providers(providers, ["c", "c", "unknown", "a"])
    assert [item["id"] for item in reordered] == ["c", "a", "b"]
    assert [item["sortOrder"] for item in reordered] == [0, 1, 2]
    assert reordered[2]["enabled"] is False
