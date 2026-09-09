import type {CanonicalQuotaWindow, UsageWindow} from '../../core/types.js';

export interface AntigravityNormalizedUsage {
    plan: string | null;
    windows: UsageWindow[];
}

export interface ModelQuotaBucket {
    id: string;
    modelId: string;
    remainingFraction: number; // 0.0 to 1.0 (e.g. 0.745 = 74.5% remaining)
    resetTime: string | null;   // ISO 8601 string, e.g. "2026-03-09T18:00:00Z"
    displayName: string;
}

function clampFraction(value: number): number {
    if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function parseIsoTimestamp(value: unknown): number | null {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Extracts available quota buckets per model from Cloud Code / Antigravity fetchAvailableModels response.
 */
export function extractModelQuotaBuckets(payload: unknown): ModelQuotaBucket[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return [];
    }

    const root = payload as Record<string, unknown>;
    const modelsObj = root.models;
    if (!modelsObj || typeof modelsObj !== 'object' || Array.isArray(modelsObj)) {
        return [];
    }

    const buckets: ModelQuotaBucket[] = [];

    for (const [modelKey, modelData] of Object.entries(modelsObj as Record<string, unknown>)) {
        if (!modelData || typeof modelData !== 'object' || Array.isArray(modelData)) {
            continue;
        }

        const modelRecord = modelData as Record<string, unknown>;
        const quotaInfo = modelRecord.quotaInfo;
        if (!quotaInfo || typeof quotaInfo !== 'object' || Array.isArray(quotaInfo)) {
            continue;
        }

        const quotaRecord = quotaInfo as Record<string, unknown>;
        const remainingFractionRaw = quotaRecord.remainingFraction;
        if (typeof remainingFractionRaw !== 'number' || !Number.isFinite(remainingFractionRaw)) {
            continue;
        }

        const remainingFraction = clampFraction(remainingFractionRaw);
        const resetTime = typeof quotaRecord.resetTime === 'string' ? quotaRecord.resetTime : null;
        const displayName = typeof modelRecord.displayName === 'string' && modelRecord.displayName.trim()
            ? modelRecord.displayName.trim()
            : modelKey;

        buckets.push({
            id: modelKey,
            modelId: modelKey,
            remainingFraction,
            resetTime,
            displayName,
        });
    }

    return buckets;
}

/**
 * Normalizes Antigravity quota into canonical UsageWindows.
 * Antigravity typically splits model quotas:
 * - Fast/frequent models (Gemini Flash / Pro) renew on short (5-hour) rolling cycles.
 * - Heavy frontier models (Claude 3.7 Sonnet / Opus, GPT-4o) share a weekly quota bucket.
 */
export function normalizeAntigravityUsage(
    loadCodeAssistPayload: unknown,
    modelsPayload: unknown
): AntigravityNormalizedUsage {
    // 1. Determine plan from loadCodeAssist response
    let plan = 'Antigravity';
    if (loadCodeAssistPayload && typeof loadCodeAssistPayload === 'object') {
        const root = loadCodeAssistPayload as Record<string, unknown>;
        const currentTier = root.currentTier as Record<string, unknown> | undefined;
        if (typeof currentTier?.name === 'string' && currentTier.name.trim()) {
            plan = currentTier.name.trim();
        } else if (typeof root.tier === 'string' && root.tier.trim()) {
            plan = root.tier.trim();
        } else if (typeof root.subscriptionTier === 'string' && root.subscriptionTier.trim()) {
            plan = root.subscriptionTier.trim();
        }
    }

    // 2. Extract model buckets
    const buckets = extractModelQuotaBuckets(modelsPayload);
    if (!buckets.length) {
        return {
            plan,
            windows: [],
        };
    }

    // 3. Map model quotas into primary and secondary usage windows
    const now = Date.now();

    // Look for representative Gemini / 5h model
    const geminiCandidate = buckets.find(b =>
        b.modelId.toLowerCase().includes('gemini') ||
        b.displayName.toLowerCase().includes('gemini')
    );

    // Look for representative Claude / GPT / frontier model
    const claudeGptCandidate = buckets.find(b =>
        b.modelId.toLowerCase().includes('claude') ||
        b.displayName.toLowerCase().includes('claude') ||
        b.modelId.toLowerCase().includes('gpt') ||
        b.displayName.toLowerCase().includes('gpt')
    );

    const windows: UsageWindow[] = [];

    function buildWindow(
        bucket: ModelQuotaBucket,
        canonicalWindow: CanonicalQuotaWindow,
        windowLabel: string
    ): UsageWindow {
        const resetTimestamp = parseIsoTimestamp(bucket.resetTime);
        const remainingFraction = bucket.remainingFraction;
        const usedFraction = clampFraction(1 - remainingFraction);

        let resetAfterSeconds: number | null = null;
        if (resetTimestamp !== null) {
            resetAfterSeconds = Math.max(0, Math.round((resetTimestamp - now) / 1000));
        }

        return {
            id: bucket.id,
            canonicalWindow,
            label: `${bucket.displayName} (${windowLabel})`,
            used: null,
            limit: null,
            percent: usedFraction,
            resetAt: resetTimestamp,
            resetAfterSeconds,
            windowSeconds: canonicalWindow === 'five-hour' ? 5 * 60 * 60 : canonicalWindow === 'weekly' ? 7 * 24 * 60 * 60 : null,
            unit: '%',
        };
    }

    if (geminiCandidate) {
        windows.push(buildWindow(geminiCandidate, 'five-hour', '5h'));
    }

    if (claudeGptCandidate) {
        windows.push(buildWindow(claudeGptCandidate, 'weekly', 'Weekly'));
    }

    // If neither matched specific family names, take up to two prominent buckets
    if (windows.length === 0) {
        const first = buckets[0];
        if (first) {
            windows.push(buildWindow(first, 'five-hour', '5-Hour Limit'));
            if (buckets.length > 1 && buckets[1]) {
                windows.push(buildWindow(buckets[1], 'weekly', 'Weekly Limit'));
            }
        }
    } else if (windows.length === 1 && buckets.length > 1) {
        const firstWindow = windows[0];
        const remaining = firstWindow ? buckets.find(b => b.id !== firstWindow.id) : undefined;
        if (remaining) {
            windows.push(buildWindow(remaining, 'weekly', 'Quota Limit'));
        }
    }

    return { plan, windows };
}
