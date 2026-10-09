import type {ProviderCollector} from './base.js';
import type {ProviderKind} from '../core/types.js';
import {CodexCollector} from './codex/collector.js';
import {ClaudeCollector} from './claude/collector.js';
import {KiroCollector} from './kiro/collector.js';
import {AntigravityCollector} from './antigravity/collector.js';
import {AdditionalProviderCollector} from './additional/collector.js';

export class CollectorRegistry {
    private collectors: Record<ProviderKind, ProviderCollector> | null;

    constructor() {
        this.collectors = {
            codex: new CodexCollector(),
            claude: new ClaudeCollector(),
            kiro: new KiroCollector(),
            antigravity: new AntigravityCollector(),
            deepseek: new AdditionalProviderCollector(),
            kimi: new AdditionalProviderCollector(),
            opencode: new AdditionalProviderCollector(),
        };
    }

    get(kind: ProviderKind): ProviderCollector {
        const collector = this.collectors?.[kind];
        if (!collector) throw new Error('Collector registry has been destroyed.');
        return collector;
    }

    destroy(): void {
        if (!this.collectors) return;
        for (const collector of Object.values(this.collectors)) collector.destroy?.();
        this.collectors = null;
    }
}
