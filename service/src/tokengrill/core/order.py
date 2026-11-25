"""The account order: by sortOrder, ties kept in stored order."""

from tokengrill.core.types import ProviderInstance


def ordered_providers(providers: list[ProviderInstance]) -> list[ProviderInstance]:
    # sorted() is stable, so equal sortOrder values keep their stored order.
    return sorted(providers, key=lambda provider: provider["sortOrder"])


def reorder_providers(providers: list[ProviderInstance], ordered_ids: list[str]) -> list[ProviderInstance]:
    by_id = {provider["id"]: provider for provider in providers}
    seen: set[str] = set()
    reordered: list[ProviderInstance] = []
    for provider_id in ordered_ids:
        provider = by_id.get(provider_id)
        if provider is None or provider_id in seen:
            continue
        reordered.append(provider)
        seen.add(provider_id)
    for provider in ordered_providers(providers):
        if provider["id"] in seen:
            continue
        reordered.append(provider)
        seen.add(provider["id"])
    return [{**provider, "sortOrder": index} for index, provider in enumerate(reordered)]
