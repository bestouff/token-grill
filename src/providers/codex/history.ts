import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {scanJsonl} from '../../storage/jsonl.js';
import type {AggregateStore} from '../../storage/aggregateStore.js';
import type {CheckpointStore} from '../../storage/checkpointStore.js';
import type {ProviderInstance, TokenTotals, UsageEvent} from '../../core/types.js';
import {providerPaths} from '../../core/paths.js';
import {isCancellation} from '../../storage/atomicJson.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');

const PARSER_VERSION = 1;
const RETENTION_SECONDS = 90 * 24 * 60 * 60;

function usage(value: unknown): TokenTotals | null {
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    const n = (key: string): number => typeof item[key] === 'number' && Number.isFinite(item[key]) ? item[key] as number : 0;
    const input = n('input_tokens');
    const output = n('output_tokens');
    const cachedInput = n('cached_input_tokens');
    const cacheWrite = n('cache_write_input_tokens');
    const reasoning = n('reasoning_output_tokens');
    const total = n('total_tokens') || input + output;
    return total || input || output ? {input, output, cachedInput, cacheWrite, reasoning, total} : null;
}

function eventFromLine(line: string, providerId: string, source: string, offset: number): UsageEvent | null {
    if (!line.includes('token_count') && !line.includes('token_usage')) return null;
    try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type !== 'event_msg') return null;
        const payload = record.payload as Record<string, unknown> | undefined;
        if (payload?.type !== 'token_count') return null;
        const info = payload.info as Record<string, unknown> | undefined;
        const totals = usage(info?.last_token_usage) || usage(info?.total_token_usage);
        if (!totals) return null;
        return {providerId, source, eventKey: `${source}:${offset}`, capturedAt: typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Date.now(), model: typeof payload.model === 'string' ? payload.model : null, totals};
    } catch { return null; }
}

export async function scanCodexHistory(instance: ProviderInstance, aggregates: AggregateStore, checkpoints: CheckpointStore, cancellable: Gio.Cancellable): Promise<{files: number; bytes: number}> {
    const paths = providerPaths(instance);
    const roots = [paths.sessionsDirectory, paths.archivedSessionsDirectory]
        .filter((path, index, all) => all.indexOf(path) === index)
        .map(path => Gio.File.new_for_path(path));
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
    let files = 0;
    let bytes = 0;
    const visit = async (directory: Gio.File): Promise<void> => {
        let enumerator: Gio.FileEnumerator;
        try {
            enumerator = await directory.enumerate_children_async('standard::name,standard::type,standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (error) {
            if (isCancellation(error)) throw error;
            if ((error as {matches?: (domain: unknown, code: number) => boolean})?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return;
            throw error;
        }
        try {
            while (true) {
                const batch = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable) as Gio.FileInfo[];
                if (!batch.length) break;
                for (const info of batch) {
                    const child = enumerator.get_child(info);
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        await visit(child);
                        continue;
                    }
                    const mtime = info.get_attribute_uint64('time::modified');
                    if (info.get_file_type() !== Gio.FileType.REGULAR || !info.get_name().endsWith('.jsonl') || mtime < cutoff) continue;
                    const source = child.get_path() || info.get_name();
                    const size = info.get_size();
                    const checkpoint = checkpoints.get(instance.id, source);
                    const start = checkpoint && checkpoint.size <= size && checkpoint.parserVersion === PARSER_VERSION ? checkpoint.offset : 0;
                    try {
                        await scanJsonl(child, start, async (line: string, offset: number) => {
                            const event = eventFromLine(line, instance.id, source, offset);
                            if (event) aggregates.add(event);
                        }, cancellable);
                        cancellable.set_error_if_cancelled();
                        checkpoints.set({providerId: instance.id, path: source, size, mtime, offset: size, parserVersion: PARSER_VERSION});
                        files += 1;
                        bytes += size;
                    } catch (error) {
                        if (isCancellation(error)) throw error;
                        /* A changing session file is retried on the next pass. */
                    }
                }
            }
        } finally {
            try {
                await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
            } catch { /* Closing is best-effort after traversal failure. */ }
        }
    };
    for (const root of roots) await visit(root);
    return {files, bytes};
}
