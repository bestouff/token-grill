import type {AggregateBucket, TokenTotals, UsageEvent} from '../core/types.js';
import {EMPTY_TOTALS} from '../core/types.js';
import {dataPath, readJsonSync, writeJsonAtomic} from './atomicJson.js';
import {costFor} from '../pricing/calculator.js';
import type {PricingCatalog} from '../pricing/catalog.js';

interface AggregateFile {schemaVersion: 1; buckets: AggregateBucket[]}

function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
    return {
        input: a.input + b.input,
        output: a.output + b.output,
        cachedInput: a.cachedInput + b.cachedInput,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        reasoning: a.reasoning + b.reasoning,
        total: a.total + b.total,
    };
}

export class AggregateStore {
    private readonly path = dataPath('history-v1.json');
    private readonly data: AggregateFile = readJsonSync<AggregateFile>(this.path, {schemaVersion: 1, buckets: []});
    private dirty = false;

    add(event: UsageEvent): void {
        const date = new Date(event.capturedAt).toISOString().slice(0, 10);
        const model = event.model || 'unknown';
        let bucket = this.data.buckets.find(item => item.providerId === event.providerId && item.date === date && item.model === model);
        if (!bucket) {
            bucket = {providerId: event.providerId, date, model, totals: {...EMPTY_TOTALS}, events: 0, sourceBytes: {}};
            this.data.buckets.push(bucket);
        }
        bucket.totals = addTotals(bucket.totals, event.totals);
        bucket.events += 1;
        bucket.sourceBytes[event.source] = (bucket.sourceBytes[event.source] || 0) + (event.totals.total || 0);
        this.dirty = true;
    }

    totals(providerId: string, sinceMs = 0): TokenTotals {
        return this.data.buckets.filter(item => item.providerId === providerId && Date.parse(`${item.date}T00:00:00Z`) >= sinceMs)
            .reduce((sum, item) => addTotals(sum, item.totals), {...EMPTY_TOTALS});
    }

    today(providerId: string): TokenTotals {
        const midnight = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
        return this.totals(providerId, midnight);
    }

    cost(providerId: string, sinceMs: number, catalog: PricingCatalog): number | null {
        const buckets = this.data.buckets.filter(item => item.providerId === providerId && Date.parse(`${item.date}T00:00:00Z`) >= sinceMs);
        let total = 0;
        let priced = false;
        for (const bucket of buckets) {
            const value = costFor(bucket.totals, catalog[bucket.model] || null);
            if (value === null) continue;
            priced = true;
            total += value;
        }
        return priced ? total : null;
    }

    prune(days: number): void {
        const cutoff = Date.now() - days * 86400000;
        this.data.buckets = this.data.buckets.filter(item => Date.parse(`${item.date}T00:00:00Z`) >= cutoff);
        this.dirty = true;
    }

    removeProvider(providerId: string): void {
        this.data.buckets = this.data.buckets.filter(item => item.providerId !== providerId);
        this.dirty = true;
        void this.flush();
    }

    async flush(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        await writeJsonAtomic(this.path, this.data);
    }
}
