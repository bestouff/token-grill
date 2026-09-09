import type {AccentColor} from './types.js';

export const ACCENT_COLORS: Record<AccentColor, string> = {
    blue: '#62a0ea',
    cyan: '#5bc0eb',
    green: '#57e389',
    amber: '#f8e45c',
    orange: '#ff9b42',
    red: '#ff6b6b',
    purple: '#c7a0ff',
    pink: '#f28cb1',
};

export function accentColor(instance: {accent: AccentColor}): string {
    return ACCENT_COLORS[instance.accent] || ACCENT_COLORS.blue;
}
