import {providerMetadata} from './providerMetadata.js';
import type {ProviderInstance, ProviderRuntimeState, ProviderSnapshot} from './types.js';

export interface HistoryMetric {
    value: string;
    unit: string;
}

export interface HistoryMetrics {
    today: HistoryMetric;
    month: HistoryMetric;
    cost: HistoryMetric;
}

function status(value: string): HistoryMetrics {
    const metric = (): HistoryMetric => ({value, unit: ''});
    return {today: metric(), month: metric(), cost: metric()};
}

export function formatTokenCount(value: number): string {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
    return value.toLocaleString();
}

export function historyMetrics(
    instance: ProviderInstance,
    snapshot: ProviderSnapshot | null,
    runtime: ProviderRuntimeState | null,
): HistoryMetrics {
    if (!providerMetadata(instance.kind).localHistorySupported) return status('Not supported');
    if (!instance.localHistoryEnabled) return status('History off');
    if (!snapshot?.localHistoryUpdatedAt) {
        if (runtime?.refresh.phase === 'scanning-history') return status('Updating…');
        if (runtime?.refresh.localHistory.phase === 'failed') return status('Scan failed');
        return status('Waiting…');
    }

    const today = snapshot.todayTotals?.total ?? 0;
    const month = snapshot.monthTotals?.total ?? 0;
    const cost = snapshot.monthCost;
    return {
        today: {value: formatTokenCount(today), unit: 'TOKENS'},
        month: {value: formatTokenCount(month), unit: 'TOKENS'},
        cost: cost !== null && cost !== undefined
            ? {value: `$${cost.toFixed(2)}`, unit: 'USD'}
            : month === 0
                ? {value: '$0.00', unit: 'USD'}
                : {value: 'No price data', unit: ''},
    };
}
