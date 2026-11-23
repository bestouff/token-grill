import type Gio from 'gi://Gio';

import {isRecord} from '../core/json.js';
import {parseStoredReading, storedReading, type StoredReading} from '../core/storedReading.js';
import type {ProviderSnapshot} from '../core/types.js';
import {readJson, SerialWriter, statePath, type WarningLogger} from './atomicJson.js';

interface SnapshotFile {
    schemaVersion: 1;
    accounts: Record<string, StoredReading>;
}

// The last limits of each account, so the popup and the top bar keep showing
// them after a lock, a restart or an update until a refresh works.
export class SnapshotStore {
    private readonly _writer = new SerialWriter(statePath('readings-v1.json'));
    private readonly _readings = new Map<string, StoredReading>();
    private readonly _logger: WarningLogger;

    constructor(logger: WarningLogger) {
        this._logger = logger;
    }

    async initialize(cancellable: Gio.Cancellable): Promise<void> {
        const file = await readJson<Partial<SnapshotFile>>(this._writer.path, {}, cancellable, this._logger);
        for (const [id, value] of Object.entries(isRecord(file.accounts) ? file.accounts : {})) {
            const reading = parseStoredReading(value);
            if (reading)
                this._readings.set(id, reading);
        }
    }

    get(providerId: string): StoredReading | null {
        return this._readings.get(providerId) ?? null;
    }

    // A snapshot without a reading, such as one cleared for a new sign-in, removes the old one.
    set(snapshot: ProviderSnapshot): void {
        const reading = storedReading(snapshot);
        if (JSON.stringify(reading) === JSON.stringify(this._readings.get(snapshot.providerId) ?? null))
            return;
        if (reading)
            this._readings.set(snapshot.providerId, reading);
        else
            this._readings.delete(snapshot.providerId);
        this._writer.markDirty();
    }

    removeProvider(providerId: string): Promise<void> {
        this._readings.delete(providerId);
        this._writer.markDirty();
        return this.flush();
    }

    flush(): Promise<void> {
        return this._writer.flush(() => ({schemaVersion: 1, accounts: Object.fromEntries(this._readings)}));
    }
}
