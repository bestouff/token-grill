import {formatText, UNTRANSLATED, type Translator} from './i18n.js';
import {parseRecord} from './json.js';
import type {ProviderErrorCode, ProviderErrorInfo} from './types.js';

// Error text is produced at display time so it follows the user's language,
// while every msgid stays a literal at the throw site.
export type ErrorText = (tr: Translator) => string;

export interface CollectorErrorDetails {
    status?: number;
    reason?: string | null;
}

export class CollectorError extends Error {
    readonly code: ProviderErrorCode;
    readonly text: ErrorText;
    readonly status: number | null;
    readonly reason: string | null;

    constructor(code: ProviderErrorCode, text: ErrorText, details: CollectorErrorDetails = {}) {
        super(text(UNTRANSLATED));
        this.name = 'CollectorError';
        this.code = code;
        this.text = text;
        this.status = details.status ?? null;
        this.reason = details.reason ?? null;
    }
}

export const OFFLINE: ErrorText = ({_}) => _('The service could not be reached.');
export const TIMED_OUT: ErrorText = ({_}) => _('The service did not answer in time.');
export const TLS_FAILED: ErrorText = ({_}) => _('A secure connection to the service could not be established.');
export const TOO_LARGE: ErrorText = ({_}) => _('The service sent an unexpectedly large response.');
export const INVALID_JSON: ErrorText = ({_}) => _('The service sent a response that could not be read.');
export const NOT_ALLOWED: ErrorText = ({_}) => _('The request was blocked because its destination is not a known service host.');
export const NO_USAGE: ErrorText = ({_}) => _('The service response did not contain any usage limits.');

const RECOVERY: Record<ProviderErrorCode, ProviderErrorInfo['recovery']> = {
    'auth-missing': 'reauthenticate',
    'auth-expired': 'reauthenticate',
    'auth-invalid': 'reauthenticate',
    'unsupported-account': 'reauthenticate',
    dependency: 'none',
    permission: 'edit-provider',
    offline: 'retry',
    timeout: 'retry',
    'rate-limited': 'retry',
    http: 'retry',
    'response-shape': 'edit-provider',
    'local-history': 'retry',
};

const TRANSIENT_CODES = new Set<ProviderErrorCode>(['offline', 'timeout', 'rate-limited']);

export function httpError(status: number, reason: string | null): CollectorError {
    let code: ProviderErrorCode = 'http';
    if (status === 401 || status === 403)
        code = 'auth-invalid';
    else if (status === 429)
        code = 'rate-limited';
    const text: ErrorText = ({_}) => reason
        ? formatText(_('The service answered with HTTP %d (%s).'), status, reason)
        : formatText(_('The service answered with HTTP %d.'), status);
    return new CollectorError(code, text, {status, reason});
}

export function isTransientError(error: unknown): boolean {
    return error instanceof CollectorError && TRANSIENT_CODES.has(error.code);
}

export function providerErrorInfo(error: CollectorError, tr: Translator): ProviderErrorInfo {
    return {code: error.code, message: error.text(tr), recovery: RECOVERY[error.code]};
}

// Only identifier-shaped values are returned, so free text that might echo
// request data never reaches the UI.
export function serviceErrorReason(body: string): string | null {
    const payload = parseRecord(body);
    if (!payload)
        return null;
    const type = typeof payload.__type === 'string' ? payload.__type.split('#').pop() : null;
    for (const candidate of [payload.reason, type, payload.error, payload.code]) {
        if (typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(candidate))
            return candidate;
    }
    return null;
}
