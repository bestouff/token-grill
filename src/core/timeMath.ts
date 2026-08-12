export interface DurationParts {
    expired: boolean;
    totalMinutes: number;
    days: number;
    hours: number;
    minutes: number;
}

export function durationUntil(targetAt: number | null, now = Date.now()): DurationParts | null {
    if (!Number.isFinite(targetAt)) return null;
    const difference = (targetAt as number) - now;
    const remaining = difference > 0 && difference < 60000 ? 0 : Math.max(0, Math.ceil(difference / 60000));
    return {
        expired: (targetAt as number) <= now,
        totalMinutes: remaining,
        days: Math.floor(remaining / 1440),
        hours: Math.floor((remaining % 1440) / 60),
        minutes: remaining % 60,
    };
}

export function formatResetDuration(parts: DurationParts | null): string {
    if (!parts) return 'reset unknown';
    if (parts.expired) return 'now';
    if (parts.totalMinutes < 1) return 'less than 1m';
    if (parts.days > 0) return `${parts.days}d ${parts.hours}h ${parts.minutes}m`;
    if (parts.hours > 0) return `${parts.hours}h ${parts.minutes}m`;
    return `${parts.minutes}m`;
}

export function formatResetCountdown(targetAt: number | null, now = Date.now()): string {
    return formatResetDuration(durationUntil(targetAt, now));
}
