// Diagnostics a tester can share: each step Token Grill took, with every
// value that could identify the user or open their accounts removed.
import type {AccountApp, ProviderKind} from './types.js';

export interface DiagnosticEntry {
    at: number;
    account: string;
    kind: ProviderKind;
    app: AccountApp;
    step: 'sign-in' | 'request' | 'response' | 'error';
    detail: string;
}

export interface ReportHeader {
    version: string;
    shell: string;
    date: string;
}

const SHAPE_DEPTH = 3;
const SHAPE_KEYS = 6;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Secrets mix letters and digits; field names such as cloud_session_storage_enabled do not.
const TOKEN = /[A-Za-z0-9_\-.]{24,}/g;
// Requests go only to fixed service hosts, such as codewhisperer.us-east-1.amazonaws.com.
const HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

// The types of a parsed response, never its values.
export function shapeOf(value: unknown, depth = SHAPE_DEPTH): string {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return `[${value.length} items]`;
    if (typeof value !== 'object')
        return typeof value;
    if (depth === 0)
        return '{...}';
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, SHAPE_KEYS).map(([key, item]) => `${key}: ${shapeOf(item, depth - 1)}`);
    if (entries.length > SHAPE_KEYS)
        shown.push(`...${entries.length - SHAPE_KEYS} more`);
    return `{${shown.join(', ')}}`;
}

// Query strings can carry keys, so only the host and path are kept.
export function requestDetail(method: string, url: string): string {
    return `${method} ${url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '')}`;
}

export function redact(text: string, home: string): string {
    return text
        .replaceAll(home, '~')
        .replace(EMAIL, '<email>')
        .replace(UUID, '<id>')
        .replace(TOKEN, match => /\d/.test(match) && /[A-Za-z]/.test(match) && !HOST.test(match) ? '<token>' : match);
}

// Accounts are numbered per service, so a report never carries the names users gave them.
export function accountLabel(kind: ProviderKind, index: number): string {
    return `${kind}-${index}`;
}

export function formatReport(entries: DiagnosticEntry[], header: ReportHeader): string {
    const lines = [`Token Grill ${header.version} - GNOME Shell ${header.shell} - ${header.date}`];
    for (const entry of entries)
        lines.push(`${new Date(entry.at).toISOString()} ${entry.account} (${entry.kind}, ${entry.app}) ${entry.step}: ${entry.detail}`);
    return `${lines.join('\n')}\n`;
}
