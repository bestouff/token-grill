import type {ProviderInstance, ProviderSnapshot} from '../../core/types.js';
import {emptySnapshot} from '../../core/types.js';
import {BaseCollector, type CollectorContext} from '../base.js';
import {KiroUsageCollector} from './usageApi.js';

export class KiroCollector extends BaseCollector {
    private readonly live = new KiroUsageCollector();

    async collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot> {
        if (!instance.liveUsageEnabled) return previous || emptySnapshot(instance.id);
        const snapshot = await this.live.collect(instance, context, previous);
        context.onSourceResult?.('limits', snapshot.error ? 'failed' : 'success');
        return snapshot;
    }
}
