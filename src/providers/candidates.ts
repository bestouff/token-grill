// Accounts that could be added from an app, and whether each is new, already
// there, the same plan as another account, or nothing Token Grill can track.
import {providerMetadata} from '../core/providerMetadata.js';
import type {Candidate, CandidateStatus, ProviderInstance} from '../core/types.js';
import {duplicateOf, identityFromOpenCode, type AccountIdentity} from './accountIdentity.js';
import {matchOpenCodeEntry, type OpenCodeEntry} from './opencode/entries.js';

export type {Candidate, CandidateStatus};

type Configured = Pick<ProviderInstance, 'id' | 'kind' | 'app'>;

const STATUS_ORDER: Record<CandidateStatus, number> = {
    ready: 0,
    'already-added': 1,
    'uses-other-app': 2,
    'nothing-to-track': 3,
};

export function byStatus(candidates: Candidate[]): Candidate[] {
    return [...candidates].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

// OpenCode keeps one sign-in per service, so a service added from OpenCode is added once.
export function openCodeCandidates(
    entries: Map<string, OpenCodeEntry>,
    configured: Configured[],
    identities: Map<string, AccountIdentity | null>,
    openCodeHome: string
): Candidate[] {
    const candidates: Candidate[] = [];
    for (const [id, entry] of entries) {
        const match = matchOpenCodeEntry(id, entry);
        const base = {app: 'opencode' as const, accountHome: openCodeHome, duplicateOf: null};
        if (match.status === 'nothing-to-track') {
            candidates.push({...base, kind: null, label: id, status: 'nothing-to-track'});
            continue;
        }
        const label = providerMetadata(match.kind).label;
        if (match.status === 'uses-other-app') {
            candidates.push({...base, kind: match.kind, label, status: 'uses-other-app'});
            continue;
        }
        const added = configured.some(item => item.kind === match.kind && item.app === 'opencode');
        candidates.push({
            ...base,
            kind: match.kind,
            label,
            status: added ? 'already-added' : 'ready',
            duplicateOf: added ? null : duplicateOf(identityFromOpenCode(id, entry), identities),
        });
    }
    return byStatus(candidates);
}
