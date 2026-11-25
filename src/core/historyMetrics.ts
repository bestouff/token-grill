import {providerMetadata} from './providerMetadata.js';
import type {ProviderInstance, ProviderRuntimeState, ProviderSnapshot} from './types.js';

export type HistoryState = 'unsupported' | 'off' | 'waiting' | 'updating' | 'failed' | 'ready';

export interface HistoryMetrics {
    state: HistoryState;
    todayTokens: number;
    monthTokens: number;
    // null when no model in the period has a known price.
    monthCost: number | null;
}

function status(state: HistoryState): HistoryMetrics {
    return {state, todayTokens: 0, monthTokens: 0, monthCost: null};
}

export function formatTokenCount(value: number): string {
    if (!Number.isFinite(value))
        return '-';
    if (value >= 1e9)
        return `${(value / 1e9).toFixed(1)}B`;
    if (value >= 1e6)
        return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3)
        return `${(value / 1e3).toFixed(1)}K`;
    return value.toLocaleString();
}

export function historyMetrics(
    instance: ProviderInstance,
    snapshot: ProviderSnapshot | null,
    runtime: ProviderRuntimeState | null
): HistoryMetrics {
    if (!providerMetadata(instance.kind).localHistorySupported)
        return status('unsupported');
    if (!instance.localHistoryEnabled)
        return status('off');
    if (!snapshot?.localHistoryUpdatedAt) {
        if (runtime?.phase === 'scanning-history')
            return status('updating');
        if (runtime?.sources.history === 'failed')
            return status('failed');
        return status('waiting');
    }

    const monthTokens = snapshot.monthTotals.total;
    return {
        state: 'ready',
        todayTokens: snapshot.todayTotals.total,
        monthTokens,
        // An empty month is free even without price data.
        monthCost: snapshot.monthCost ?? (monthTokens === 0 ? 0 : null),
    };
}
