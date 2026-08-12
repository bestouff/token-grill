import GLib from 'gi://GLib';

export class Lifecycle {
    private sources = new Set<number>();
    private cancellables = new Set<GioCancellable>();
    private disposed = false;

    addSource(id: number): number {
        if (!this.disposed)
            this.sources.add(id);
        return id;
    }

    addCancellable<T extends GioCancellable>(cancellable: T): T {
        if (!this.disposed)
            this.cancellables.add(cancellable);
        return cancellable;
    }

    removeSource(id: number | null): void {
        if (id !== null) {
            GLib.Source.remove(id);
            this.sources.delete(id);
        }
    }

    dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const source of this.sources)
            GLib.Source.remove(source);
        this.sources.clear();
        for (const cancellable of this.cancellables)
            cancellable.cancel();
        this.cancellables.clear();
    }
}

type GioCancellable = {cancel(): void};

