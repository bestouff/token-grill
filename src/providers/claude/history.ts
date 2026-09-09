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

function extract(record: Record<string, unknown>): TokenTotals | null {
    const usage = (record.usage || record.token_usage || (record.message as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
    if (!usage) return null;
    const number = (key: string): number => typeof usage[key] === 'number' ? usage[key] as number : 0;
    const input = number('input_tokens');
    const output = number('output_tokens');
    const cachedInput = number('cache_read_input_tokens') || number('cached_input_tokens');
    const cacheWrite = number('cache_creation_input_tokens') || number('cache_write_input_tokens');
    const total = number('total_tokens') || input + output;
    return total ? {input, output, cachedInput, cacheWrite, reasoning: 0, total} : null;
}

function event(line: string, providerId: string, source: string, offset: number): UsageEvent | null {
    if (!line.includes('input_tokens') && !line.includes('usage')) return null;
    try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const totals = extract(record);
        if (!totals) return null;
        const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Date.now();
        const model = typeof record.model === 'string' ? record.model : typeof (record.message as Record<string, unknown> | undefined)?.model === 'string' ? (record.message as Record<string, unknown>).model as string : null;
        return {providerId, source, eventKey: `${source}:${offset}`, capturedAt: timestamp, model, totals};
    } catch { return null; }
}

export async function scanClaudeHistory(instance: ProviderInstance, aggregates: AggregateStore, checkpoints: CheckpointStore, cancellable: Gio.Cancellable): Promise<{files: number; bytes: number}> {
    const root = Gio.File.new_for_path(providerPaths(instance).sessionsDirectory);
    let files = 0; let bytes = 0;
    const cutoff = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
    const walk = async (directory: Gio.File): Promise<void> => {
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
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) { await walk(child); continue; }
                    if (info.get_file_type() !== Gio.FileType.REGULAR || !info.get_name().endsWith('.jsonl') || info.get_attribute_uint64('time::modified') < cutoff) continue;
                    const source = child.get_path() || info.get_name(); const size = info.get_size();
                    const checkpoint = checkpoints.get(instance.id, source); const start = checkpoint && checkpoint.size <= size ? checkpoint.offset : 0;
                    try {
                        await scanJsonl(child, start, async (line: string, offset: number) => { const item = event(line, instance.id, source, offset); if (item) aggregates.add(item); }, cancellable);
                        cancellable.set_error_if_cancelled();
                        checkpoints.set({providerId: instance.id, path: source, size, mtime: info.get_attribute_uint64('time::modified'), offset: size, parserVersion: 1});
                        files++; bytes += size;
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
    await walk(root);
    return {files, bytes};
}
