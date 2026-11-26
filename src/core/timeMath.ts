import {formatText, type Translator} from './i18n.js';

interface DurationParts {
    expired: boolean;
    totalMinutes: number;
    days: number;
    hours: number;
    minutes: number;
}

export function durationUntil(targetAt: number | null, now = Date.now()): DurationParts | null {
    if (targetAt === null || !Number.isFinite(targetAt))
        return null;
    const difference = targetAt - now;
    const remaining = difference > 0 && difference < 60000 ? 0 : Math.max(0, Math.ceil(difference / 60000));
    return {
        expired: targetAt <= now,
        totalMinutes: remaining,
        days: Math.floor(remaining / 1440),
        hours: Math.floor((remaining % 1440) / 60),
        minutes: remaining % 60,
    };
}

// GNOME Shell's formatTime() uses %l, and GLib pads a one-digit hour with a
// figure space, which leaves a wide gap inside a sentence.
export function tidyClock(text: string): string {
    return text.trim().replace(/\s{2,}/g, ' ');
}

// `compact` drops the minutes once a duration reaches whole days.
export function formatDuration(tr: Translator, parts: DurationParts, compact = false): string {
    const {_} = tr;
    if (parts.totalMinutes < 1)
        return _('less than 1m');
    if (parts.days > 0 && compact)
        return formatText(_('%dd %dh'), parts.days, parts.hours);
    if (parts.days > 0)
        return formatText(_('%dd %dh %dm'), parts.days, parts.hours, parts.minutes);
    if (parts.hours > 0)
        return formatText(_('%dh %dm'), parts.hours, parts.minutes);
    return formatText(_('%dm'), parts.minutes);
}
