import type {ProviderInstance} from './types.js';

export function orderedProviders(providers: ProviderInstance[]): ProviderInstance[] {
    return providers
        .map((provider, index) => ({provider, index}))
        .sort((a, b) => a.provider.sortOrder - b.provider.sortOrder || a.index - b.index)
        .map(({provider}) => provider);
}

export function reorderProviders(providers: ProviderInstance[], orderedIds: string[]): ProviderInstance[] {
    const byId = new Map(providers.map(provider => [provider.id, provider]));
    const seen = new Set<string>();
    const reordered: ProviderInstance[] = [];
    for (const id of orderedIds) {
        const provider = byId.get(id);
        if (!provider || seen.has(id)) continue;
        reordered.push(provider);
        seen.add(id);
    }
    for (const provider of orderedProviders(providers)) {
        if (seen.has(provider.id)) continue;
        reordered.push(provider);
        seen.add(provider.id);
    }
    return reordered.map((provider, sortOrder) => ({...provider, sortOrder}));
}
