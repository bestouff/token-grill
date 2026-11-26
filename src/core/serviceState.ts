import type {
    Alert, ImportResult, ProviderInstance, ProviderRuntimeState, ProviderSnapshot, ServiceState, Settings,
} from './types.js';

export type ClientStatus = 'connecting' | 'missing' | 'too-old' | 'not-responding' | 'connected';

const SERVICE_UNKNOWN = 'org.freedesktop.DBus.Error.ServiceUnknown';

// A payload that is not JSON of the shape and schema this client reads: the client cannot use what the service sent.
export class ServiceSchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ServiceSchemaError';
    }
}

// What a failed first call says about the service. A remote error carries its D-Bus name as `code`
// (ServiceCallError); the name is read before the message is stripped of it.
export function statusForError(error: unknown): ClientStatus {
    if (error instanceof ServiceSchemaError)
        return 'too-old';
    const code = (error as {code?: unknown} | null)?.code;
    return code === SERVICE_UNKNOWN ? 'missing' : 'not-responding';
}

function parseObject(text: string, what: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new ServiceSchemaError(`The ${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ServiceSchemaError(`The ${what} is not an object`);
    const record = value as Record<string, unknown>;
    if (record['schema'] !== 1)
        throw new ServiceSchemaError(`The ${what} has an unsupported schema`);
    return record;
}

export function parseState(text: string): ServiceState {
    return parseObject(text, 'service state') as unknown as ServiceState;
}

export function parseAccounts(text: string): ProviderInstance[] {
    return parseObject(text, 'account list')['accounts'] as ProviderInstance[];
}

export function parseSettings(text: string): Settings {
    return parseObject(text, 'settings')['settings'] as Settings;
}

export function parseAlert(text: string): Alert {
    return parseObject(text, 'alert') as unknown as Alert;
}

interface AccountUpdate {
    snapshot: ProviderSnapshot;
    runtime: ProviderRuntimeState;
}

export function parseAccountChanged(text: string): AccountUpdate {
    const record = parseObject(text, 'account update');
    return {snapshot: record['snapshot'] as ProviderSnapshot, runtime: record['runtime'] as ProviderRuntimeState};
}

export function parseResult(text: string): Record<string, unknown> {
    return parseObject(text, 'service result');
}

// Only an explicit "not refused" lets the caller drop its own copy of the values.
export function parseImportResult(text: string): ImportResult {
    const result = parseResult(text);
    const imported = result['imported'];
    return {imported: typeof imported === 'number' ? imported : 0, refused: result['refused'] !== false};
}
