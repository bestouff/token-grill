import type {LimitResetCredit, LimitResetCreditSummary, ResetCreditStatus} from '../../core/types.js';

function value(item: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) if (item[key] !== undefined) return item[key];
    return null;
}

function numberValue(item: Record<string, unknown>, keys: string[]): number | null {
    const raw = value(item, keys);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function timestampValue(item: Record<string, unknown>, keys: string[]): number | null {
    const raw = value(item, keys);
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 10_000_000_000 ? raw * 1000 : raw;
    if (typeof raw === 'string' && raw.trim()) {
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function normalizeStatus(item: Record<string, unknown>): ResetCreditStatus {
    const status = String(value(item, ['status']) ?? '').toLowerCase();
    if (status === 'available') return 'available';
    if (status === 'redeemed') return 'redeemed';
    if (status === 'expired') return 'expired';
    if (!status && timestampValue(item, ['redeemed_at', 'redeemedAt']) === null) return 'available';
    return 'unknown';
}

function normalizeCredit(raw: unknown): LimitResetCredit | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    return {
        resetType: typeof value(item, ['reset_type', 'resetType']) === 'string' ? String(value(item, ['reset_type', 'resetType'])) : null,
        title: typeof value(item, ['title']) === 'string' ? String(value(item, ['title'])) : null,
        status: normalizeStatus(item),
        grantedAt: timestampValue(item, ['granted_at', 'grantedAt']),
        expiresAt: timestampValue(item, ['expires_at', 'expiresAt']),
    };
}

export function normalizeResetCredits(payload: unknown, fetchedAt = Date.now()): LimitResetCreditSummary | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const source = payload as Record<string, unknown>;
    const rawCredits = Array.isArray(source.credits) ? source.credits : [];
    const credits = rawCredits.map(normalizeCredit).filter((item): item is LimitResetCredit => item !== null);
    const available = credits.filter(item => item.status === 'available');
    const countRaw = numberValue(source, ['available_count', 'availableCount']);
    const totalRaw = numberValue(source, ['total_earned_count', 'totalEarnedCount']);
    const nextExpiresAt = available.reduce<number | null>((earliest, item) => {
        if (item.expiresAt === null) return earliest;
        return earliest === null || item.expiresAt < earliest ? item.expiresAt : earliest;
    }, null);
    return {
        supported: true,
        availableCount: countRaw === null ? available.length : Math.max(0, Math.round(countRaw)),
        totalEarnedCount: totalRaw === null ? null : Math.max(0, Math.round(totalRaw)),
        nextExpiresAt,
        credits: available,
        fetchedAt,
        stale: false,
        error: null,
    };
}
