import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {isCancellation} from '../storage/atomicJson.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

export interface ModelRate {input: number; output: number; cachedInput?: number; cacheWrite?: number}
export type PricingCatalog = Record<string, ModelRate>;

export async function loadCatalog(basePath: string | null = null, cancellable: Gio.Cancellable | null = null): Promise<PricingCatalog> {
    try {
        const path = basePath || GLib.build_filenamev([GLib.get_current_dir(), 'resources', 'pricing', 'pricing-v1.json']);
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as {models?: PricingCatalog};
        return payload.models || {};
    } catch (error) {
        if (isCancellation(error)) throw error;
        return {};
    }
}

export function rateFor(catalog: PricingCatalog, model: string | null): ModelRate | null {
    if (!model) return null;
    if (catalog[model]) return catalog[model] ?? null;
    const lower = model.toLowerCase();
    const key = Object.keys(catalog).find(candidate => lower.includes(candidate.toLowerCase()) || candidate.toLowerCase().includes(lower));
    return key ? catalog[key] ?? null : null;
}
