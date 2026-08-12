import {CollectorError} from '../../core/errors.js';

export interface KiroAuth {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number;
    region: string;
    serviceRegion: string;
    clientId: string | null;
    clientSecret: string | null;
    clientSecretExpiresAt: number | null;
    profileArn: string | null;
    path: string;
}

function parseObject(value: unknown, message: string): Record<string, unknown> {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* mapped to a sanitized provider error below */ }
    throw new CollectorError(message, 'auth-invalid');
}

function timestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 10000000000 ? value * 1000 : value;
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function parseProfileArn(value: string | null): string | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const candidate = parsed.arn ?? parsed.profileArn ?? parsed.profile_arn;
        return typeof candidate === 'string' && candidate ? candidate : null;
    } catch {
        return value.startsWith('arn:') ? value : null;
    }
}

export function parseKiroAuthRecords(tokenRaw: string | null, registrationRaw: string | null, profileRaw: string | null, path: string): KiroAuth {
    if (!tokenRaw) throw new CollectorError('No active Kiro CLI login was found. Run kiro-cli login.', 'auth-missing');
    const token = parseObject(tokenRaw, 'The Kiro CLI token record is invalid.');
    const registration = registrationRaw ? parseObject(registrationRaw, 'The Kiro CLI device registration is invalid.') : {};
    const accessToken = typeof token.access_token === 'string' ? token.access_token.trim() : '';
    const refreshToken = typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : null;
    const region = typeof token.region === 'string' && token.region ? token.region : typeof registration.region === 'string' ? registration.region : '';
    const expiresAt = timestamp(token.expires_at);
    if (!accessToken) throw new CollectorError('No Kiro CLI access token was found. Run kiro-cli login.', 'auth-missing');
    if (!region) throw new CollectorError('The Kiro authentication region is missing. Run kiro-cli login.', 'auth-invalid');
    if (expiresAt === null) throw new CollectorError('The Kiro access-token expiry is invalid. Run kiro-cli login.', 'auth-invalid');
    const profileArn = parseProfileArn(profileRaw);
    const arnRegion = profileArn?.split(':')[3] || null;
    const supportedServiceRegions = ['us-east-1', 'eu-central-1', 'us-gov-east-1', 'us-gov-west-1', 'us-iso-east-1', 'us-isob-east-1', 'us-isof-south-1', 'us-isof-east-1'];
    const serviceRegion = arnRegion && supportedServiceRegions.includes(arnRegion) ? arnRegion : supportedServiceRegions.includes(region) ? region : 'us-east-1';
    return {
        accessToken,
        refreshToken,
        expiresAt,
        region,
        serviceRegion,
        clientId: typeof registration.client_id === 'string' ? registration.client_id : null,
        clientSecret: typeof registration.client_secret === 'string' ? registration.client_secret : null,
        clientSecretExpiresAt: timestamp(registration.client_secret_expires_at),
        profileArn,
        path,
    };
}

export function isKiroTokenFresh(auth: Pick<KiroAuth, 'accessToken' | 'expiresAt'>, now = Date.now()): boolean {
    return Boolean(auth.accessToken) && auth.expiresAt > now + 60000;
}
