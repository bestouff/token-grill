import type {FileCheckpoint} from '../core/types.js';
import {readJsonSync, statePath, writeJsonAtomic} from './atomicJson.js';

interface CheckpointFile {schemaVersion: 1; files: FileCheckpoint[]}

export class CheckpointStore {
    private readonly path = statePath('checkpoints-v1.json');
    private readonly data: CheckpointFile = readJsonSync<CheckpointFile>(this.path, {schemaVersion: 1, files: []});

    get(providerId: string, path: string): FileCheckpoint | null {
        return this.data.files.find(item => item.providerId === providerId && item.path === path) ?? null;
    }

    set(checkpoint: FileCheckpoint): void {
        const index = this.data.files.findIndex(item => item.providerId === checkpoint.providerId && item.path === checkpoint.path);
        if (index >= 0) this.data.files[index] = checkpoint;
        else this.data.files.push(checkpoint);
        void writeJsonAtomic(this.path, this.data);
    }

    removeProvider(providerId: string): void {
        this.data.files.splice(0, this.data.files.length, ...this.data.files.filter(item => item.providerId !== providerId));
        void writeJsonAtomic(this.path, this.data);
    }
}

