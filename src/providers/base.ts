// @ts-nocheck
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import type {ProviderInstance, ProviderSnapshot} from '../core/types.js';
import {emptySnapshot} from '../core/types.js';
import {CollectorError, providerErrorInfo, safeError} from '../core/errors.js';
import {AggregateStore} from '../storage/aggregateStore.js';
import {CheckpointStore} from '../storage/checkpointStore.js';
import type {PricingCatalog} from '../pricing/catalog.js';

export interface CollectorContext {
    aggregates: AggregateStore;
    checkpoints: CheckpointStore;
    session: Soup.Session;
    catalog: PricingCatalog;
    getJson: (session: Soup.Session, url: string, headers: Record<string, string>) => Promise<unknown>;
    requestJson: (session: Soup.Session, method: string, url: string, headers: Record<string, string>, body?: unknown) => Promise<unknown>;
    onSourcePhase?: (source: 'limits' | 'reset-credits' | 'history') => void;
    onSourceResult?: (source: 'limits' | 'reset-credits' | 'history', result: 'success' | 'failed') => void;
}

export interface ProviderCollector {
    collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot>;
}

export abstract class BaseCollector implements ProviderCollector {
    abstract collect(instance: ProviderInstance, context: CollectorContext, previous: ProviderSnapshot | null): Promise<ProviderSnapshot>;

    protected failed(instance: ProviderInstance, previous: ProviderSnapshot | null, error: unknown): ProviderSnapshot {
        const snapshot = previous ? {...previous} : emptySnapshot(instance.id);
        snapshot.state = snapshot.lastUpdated ? 'stale' : 'error';
        snapshot.error = safeError(error);
        snapshot.errorInfo = providerErrorInfo(error);
        return snapshot;
    }

    protected async getJson(session: Soup.Session, url: string, headers: Record<string, string>): Promise<unknown> {
        return getJson(session, url, headers);
    }
}

export async function getJson(session: Soup.Session, url: string, headers: Record<string, string>): Promise<unknown> {
    return requestJson(session, 'GET', url, headers);
}

export async function requestJson(session: Soup.Session, method: string, url: string, headers: Record<string, string>, requestBody?: unknown): Promise<unknown> {
        if (!providerUrlAllowed(url)) throw new CollectorError('The provider request destination is not allowed.', 'http');
        const message = Soup.Message.new(method, url);
        if (!message) throw new CollectorError('Could not create the provider request.');
        message.set_flags(message.get_flags() | Soup.MessageFlags.NO_REDIRECT);
        const requestHeaders = message.get_request_headers();
        for (const [key, value] of Object.entries(headers)) requestHeaders.append(key, value);
        if (requestBody !== undefined) {
            const encoded = new TextEncoder().encode(JSON.stringify(requestBody));
            message.set_request_body_from_bytes(headers['Content-Type'] || headers['content-type'] || 'application/json', new GLib.Bytes(encoded));
        }
        let bytes;
        let oversized = false;
        const cancellable = new Gio.Cancellable();
        message.connect('got-headers', () => {
            const length = message.get_response_headers().get_content_length();
            if (length > MAX_RESPONSE_BYTES) {
                oversized = true;
                cancellable.cancel();
            }
        });
        try {
            bytes = await session.send_and_read_async(message, 0, cancellable);
        } catch (error) {
            if (oversized) throw new CollectorError('The provider response was too large.', 'response-shape');
            const detail = error instanceof Error ? error.message : String(error);
            if (/timed?\s*out|timeout/i.test(detail)) throw new CollectorError('The provider request timed out.', 'timeout');
            throw new CollectorError('The provider service could not be reached.', 'offline');
        }
        const bodyBytes = bytes?.toArray?.() ?? bytes?.get_data?.() ?? [];
        if (bodyBytes.length > MAX_RESPONSE_BYTES) throw new CollectorError('The provider response was too large.', 'response-shape');
        const body = new TextDecoder().decode(bodyBytes);
        if (message.status_code < 200 || message.status_code >= 300) {
            const code = message.status_code === 401 || message.status_code === 403 ? 'auth' : message.status_code === 429 ? 'rate-limit' : 'http';
            throw new CollectorError(`Provider request failed (HTTP ${message.status_code}).`, code);
        }
        let payload: unknown = null;
        try { payload = body ? JSON.parse(body) : null; } catch { throw new CollectorError('The provider returned invalid JSON.', 'response-shape'); }
        return payload;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const FIXED_PROVIDER_HOSTS = new Set([
    'chatgpt.com',
    'api.anthropic.com',
    'codewhisperer.us-east-1.amazonaws.com',
    'q.eu-central-1.amazonaws.com',
]);

export function providerUrlAllowed(url: string): boolean {
    try {
        const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        const host = uri.get_host() || '';
        if (uri.get_scheme() !== 'https' || uri.get_userinfo() || !host) return false;
        return FIXED_PROVIDER_HOSTS.has(host) ||
            /^oidc\.[a-z0-9-]+\.amazonaws\.com$/.test(host) ||
            /^q\.us-gov-(east|west)-1\.amazonaws\.com$/.test(host) ||
            ['q.us-iso-east-1.c2s.ic.gov', 'q.us-isob-east-1.sc2s.sgov.gov', 'q.us-isof-south-1.csp.hci.ic.gov', 'q.us-isof-east-1.csp.hci.ic.gov'].includes(host);
    } catch {
        return false;
    }
}
