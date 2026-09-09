// @ts-nocheck
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');

const CHUNK_SIZE = 256 * 1024;
const MAX_PREFIX = 256 * 1024;

/** Stream a JSONL file without ever loading the file into memory. */
export async function scanJsonl(file, startOffset, onLine, cancellable: Gio.Cancellable | null = null) {
    const input = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    try {
        if (startOffset > 0) {
            let skipped = 0;
            while (skipped < startOffset) {
                const bytes = await input.read_bytes_async(Math.min(CHUNK_SIZE, startOffset - skipped), GLib.PRIORITY_DEFAULT, cancellable);
                const length = bytes?.get_size?.() ?? bytes?.toArray?.().length ?? 0;
                if (!length) break;
                skipped += length;
            }
        }
        const decoder = new TextDecoder();
        let prefix = '';
        let lineBytes = 0;
        let lineOffset = startOffset;
        let consumed = startOffset;
        let sliceStarted = Date.now();
        while (true) {
            const bytes = await input.read_bytes_async(CHUNK_SIZE, GLib.PRIORITY_DEFAULT, cancellable);
            const array = bytes?.toArray?.() ?? [];
            if (!array.length) break;
            const text = decoder.decode(array, {stream: true});
            for (const character of text) {
                if (character === '\n') {
                    cancellable?.set_error_if_cancelled();
                    await onLine(prefix, lineOffset, lineBytes + 1);
                    lineOffset += lineBytes + 1;
                    consumed = lineOffset;
                    prefix = '';
                    lineBytes = 0;
                } else {
                    if (prefix.length < MAX_PREFIX) prefix += character;
                    lineBytes += new TextEncoder().encode(character).byteLength;
                }
            }
            // Keep initial indexing cooperative with the Shell main loop.  The
            // scanner remains single-file/single-account, but never monopolizes
            // the loop for an entire multi-hundred-megabyte history.
            if (Date.now() - sliceStarted >= 8) {
                await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
                cancellable?.set_error_if_cancelled();
                sliceStarted = Date.now();
            }
        }
        decoder.decode();
        return consumed;
    } finally {
        try {
            await input.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch { /* Closing is best-effort after a failed or cancelled read. */ }
    }
}
