import {formatText, type Translator} from './i18n.js';
import type {UsageWindow} from './types.js';

export type PaceState = 'high' | 'on-track' | 'low';

export interface Pace {
    state: PaceState;
    text: string;
}

type PacedWindow = Pick<UsageWindow, 'percent' | 'resetAt' | 'durationSeconds'>;

// Within ten points of an even pace counts as on track; the first tenth of a
// window has too little usage behind it to tell.
const BAND = 0.1;
const MIN_ELAPSED = 0.1;

// How far usage is ahead of an even pace through the window, as a fraction of
// the limit. Only a window whose length the service reports has a pace.
export function paceLead({percent, resetAt, durationSeconds}: PacedWindow, now = Date.now()): number | null {
    if (percent === null || resetAt === null || durationSeconds === null)
        return null;
    const elapsed = 1 - (resetAt - now) / (durationSeconds * 1000);
    if (elapsed < MIN_ELAPSED || elapsed >= 1)
        return null;
    return percent - elapsed;
}

export function paceState(lead: number): PaceState {
    if (lead > BAND)
        return 'high';
    return lead < -BAND ? 'low' : 'on-track';
}

// When the limit runs out at the current rate, if that is before the reset.
function runsOutAt({percent, resetAt, durationSeconds}: PacedWindow, now: number): number | null {
    if (percent === null || resetAt === null || durationSeconds === null || percent <= 0)
        return null;
    const start = resetAt - durationSeconds * 1000;
    const at = start + (now - start) / percent;
    return at < resetAt ? at : null;
}

export function windowPace(tr: Translator, window: PacedWindow, clock: (timestamp: number) => string, now = Date.now()): Pace | null {
    const {_} = tr;
    const lead = paceLead(window, now);
    if (lead === null)
        return null;
    const state = paceState(lead);
    if (state === 'low')
        return {state, text: _('Slow pace: much of this limit will be left at the reset')};
    if (state === 'on-track')
        return {state, text: _('On pace for this period')};
    const at = runsOutAt(window, now);
    if (at === null || at <= now)
        return {state, text: _('Fast pace: used up before the reset')};
    return {state, text: formatText(_('Fast pace: at this rate, it runs out around %s'), clock(at))};
}

// The pace the top bar shows for an account: that of its most pressed shown limit.
export function accountPace(windows: PacedWindow[], now = Date.now()): PaceState | null {
    const leads = windows.map(window => paceLead(window, now)).filter((lead): lead is number => lead !== null);
    return leads.length ? paceState(Math.max(...leads)) : null;
}
