import type {ProviderInstance, ProviderSnapshot} from '../../core/types.js';
import {emptySnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext} from '../base.js';
import {CodexUsageCollector} from './usageApi.js';
import {scanCodexHistory} from './history.js';
import {collectCodexResetCredits} from './resetCreditsApi.js';

export class CodexCollector extends BaseCollector {
    private readonly live = new CodexUsageCollector();
    async collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot> {
        let snapshot = previous || emptySnapshot(instance.id);
        if (instance.liveUsageEnabled) {
            snapshot = await this.live.collect(instance, context, snapshot);
            context.onSourceResult?.('limits', snapshot.error ? 'failed' : 'success');
            try {
                context.onSourcePhase?.('reset-credits');
                const credits = await collectCodexResetCredits(instance, context, snapshot);
                snapshot = {...snapshot, resetCredits: credits, resetCreditsFetchedAt: credits?.fetchedAt ?? snapshot.resetCreditsFetchedAt};
                context.onSourceResult?.('reset-credits', 'success');
            } catch {
                context.onSourceResult?.('reset-credits', 'failed');
                // Reset credits are an optional capability; quota data remains valid.
            }
        }
        if (instance.localHistoryEnabled) {
            try {
                context.onSourcePhase?.('history');
                const indexed = await scanCodexHistory(instance, context.aggregates, context.checkpoints);
                await context.aggregates.flush();
                const today = new Date(); today.setUTCHours(0, 0, 0, 0);
                const monthStart = Date.now() - 30 * 86400000;
                snapshot = {...snapshot, indexedFiles: indexed.files, indexedBytes: indexed.bytes, totals: context.aggregates.totals(instance.id), todayTotals: context.aggregates.today(instance.id), monthTotals: context.aggregates.totals(instance.id, monthStart), todayCost: context.aggregates.cost(instance.id, today.getTime(), context.catalog), monthCost: context.aggregates.cost(instance.id, monthStart, context.catalog)};
                context.onSourceResult?.('history', 'success');
            } catch (error) { context.onSourceResult?.('history', 'failed'); snapshot = this.failed(instance, snapshot, error); }
        }
        return snapshot;
    }
}
