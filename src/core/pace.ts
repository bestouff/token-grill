import {formatText, type Translator} from './i18n.js';
import type {PaceLevel, PaceState} from './types.js';

// The line under a limit in the popup.
export interface PaceLine {
    state: PaceLevel;
    text: string;
}

// The service works out the pace; a time it sent that has passed since means the limit is used up.
export function paceLine(tr: Translator, pace: PaceState, clock: (timestamp: number) => string, now = Date.now()): PaceLine {
    const {_} = tr;
    const {state, runsOutAt} = pace;
    if (state === 'low')
        return {state, text: _('Slow pace: much of this limit will be left at the reset')};
    if (state === 'on-track')
        return {state, text: _('On pace for this period')};
    if (runsOutAt === null || runsOutAt <= now)
        return {state, text: _('Fast pace: used up before the reset')};
    return {state, text: formatText(_('Fast pace: at this rate, it runs out around %s'), clock(runsOutAt))};
}
