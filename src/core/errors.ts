export class CollectorError extends Error {
    readonly code: string;
    readonly retryAfter: number | null;
    constructor(message: string, code = 'collector-error', retryAfter: number | null = null) {
        super(message);
        this.name = 'CollectorError';
        this.code = code;
        this.retryAfter = retryAfter;
    }
}

export function providerErrorInfo(error: unknown) {
    const rawCode = error instanceof CollectorError ? error.code : 'collector-error';
    const code = rawCode === 'auth' ? 'auth-invalid' : rawCode === 'auth-missing' ? 'auth-missing' : rawCode === 'auth-expired' ? 'auth-expired' : rawCode === 'dependency' ? 'dependency' : rawCode === 'rate-limit' ? 'rate-limited' : rawCode === 'response-shape' ? 'response-shape' : rawCode === 'timeout' ? 'timeout' : rawCode === 'offline' ? 'offline' : rawCode === 'permission' ? 'permission' : 'http';
    return {
        code,
        message: safeError(error),
        recovery: code === 'auth-invalid' || code === 'auth-expired' || code === 'auth-missing' ? 'reauthenticate' : code === 'response-shape' ? 'edit-provider' : code === 'permission' ? 'edit-provider' : code === 'rate-limited' ? 'retry' : 'retry',
        occurredAt: Date.now(),
        retryAt: null,
    } as const;
}

export function safeError(error: unknown): string {
    if (error instanceof CollectorError)
        return error.message;
    if (error instanceof Error)
        return error.message;
    return 'The provider could not be refreshed.';
}
