import type {ProviderCollector} from './base.js';
import type {ProviderKind} from '../core/types.js';
import {CodexCollector} from './codex/collector.js';
import {ClaudeCollector} from './claude/collector.js';
import {KiroCollector} from './kiro/collector.js';

const collectors: Record<ProviderKind, ProviderCollector> = {
    codex: new CodexCollector(),
    claude: new ClaudeCollector(),
    kiro: new KiroCollector(),
};

export function collectorFor(kind: ProviderKind): ProviderCollector { return collectors[kind]; }
