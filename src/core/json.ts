// Readers for untyped JSON from services and credential files.

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Text from another program may be truncated or rewritten while it is read.
export function parseRecord(text: string): Record<string, unknown> | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    return isRecord(value) ? value : null;
}

export function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = record[key];
    return isRecord(value) ? value : null;
}

export function numberAt(record: Record<string, unknown>, key: string): number | null {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function stringAt(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : null;
}

// Services mix epoch seconds, epoch milliseconds and ISO 8601 strings. Epoch
// values below 1e10 are seconds: as milliseconds they would predate 1970-04.
export function toEpochMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value))
        return value < 1e10 ? value * 1000 : value;
    if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

// Some services send numbers as decimal strings.
export function toNumber(value: unknown): number | null {
    const number = typeof value === 'string' && value.trim() ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

export function clampFraction(value: number): number {
    return Math.max(0, Math.min(1, value));
}
