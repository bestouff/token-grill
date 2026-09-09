import type {FileCheckpoint} from '../core/types.js';
import Gio from 'gi://Gio';
import {readJson, statePath, writeJsonAtomic} from './atomicJson.js';

interface CheckpointFile {schemaVersion: 1; files: FileCheckpoint[]}

export class CheckpointStore {
    private readonly path = statePath('checkpoints-v1.json');
    private data: CheckpointFile = {schemaVersion: 1, files: []};
    private writeChain: Promise<void> = Promise.resolve();

    async initialize(cancellable: Gio.Cancellable | null = null): Promise<void> {
        this.data = await readJson<CheckpointFile>(this.path, {schemaVersion: 1, files: []}, cancellable);
    }

    get(providerId: string, path: string): FileCheckpoint | null {
        return this.data.files.find(item => item.providerId === providerId && item.path === path) ?? null;
    }

    set(checkpoint: FileCheckpoint): void {
        const index = this.data.files.findIndex(item => item.providerId === checkpoint.providerId && item.path === checkpoint.path);
        if (index >= 0) this.data.files[index] = checkpoint;
        else this.data.files.push(checkpoint);
        this.persist();
    }

    removeProvider(providerId: string): void {
        this.data.files.splice(0, this.data.files.length, ...this.data.files.filter(item => item.providerId !== providerId));
        this.persist();
    }

    private persist(): void {
        const snapshot = JSON.parse(JSON.stringify(this.data)) as CheckpointFile;
        this.writeChain = this.writeChain.then(() => writeJsonAtomic(this.path, snapshot)).catch(() => {});
    }

    flush(): Promise<void> { return this.writeChain; }
}
