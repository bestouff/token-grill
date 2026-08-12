import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export interface ModelRate {input: number; output: number; cachedInput?: number; cacheWrite?: number}
export type PricingCatalog = Record<string, ModelRate>;

export function loadCatalog(basePath: string | null = null): PricingCatalog {
    try {
        const path = basePath || GLib.build_filenamev([GLib.get_current_dir(), 'resources', 'pricing', 'pricing-v1.json']);
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as {models?: PricingCatalog};
        return payload.models || {};
    } catch { return {}; }
}

export function rateFor(catalog: PricingCatalog, model: string | null): ModelRate | null {
    if (!model) return null;
    if (catalog[model]) return catalog[model] ?? null;
    const lower = model.toLowerCase();
    const key = Object.keys(catalog).find(candidate => lower.includes(candidate.toLowerCase()) || candidate.toLowerCase().includes(lower));
    return key ? catalog[key] ?? null : null;
}
