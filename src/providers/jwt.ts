import GLib from 'gi://GLib';

import {parseRecord, stringAt, toEpochMs} from '../core/json.js';

function jwtClaims(token: string): Record<string, unknown> | null {
    const [, claims] = token.split('.');
    if (!claims)
        return null;
    const base64 = claims.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(claims.length / 4) * 4, '=');
    return parseRecord(new TextDecoder().decode(GLib.base64_decode(base64)));
}

// The `exp` claim of a JWT access token tells whether a request is worth sending.
export function jwtExpiry(token: string): number | null {
    const payload = jwtClaims(token);
    return payload ? toEpochMs(payload.exp) : null;
}

// The `sub` claim names the account the token belongs to.
export function jwtSubject(token: string): string | null {
    const payload = jwtClaims(token);
    return payload ? stringAt(payload, 'sub') : null;
}
