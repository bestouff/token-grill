import {CollectorError} from '../../core/errors.js';

export interface KiroRoute {
    region: string;
    profileArn: string | null;
}

function validateRegion(region: string): void {
    if (!/^[a-z0-9-]+$/.test(region))
        throw new CollectorError('The Kiro authentication region is invalid.', 'auth-invalid');
}

export function kiroOidcEndpoint(region: string): string {
    validateRegion(region);
    return `https://oidc.${region}.amazonaws.com/token`;
}

export function kiroServiceEndpoint(region: string): string {
    validateRegion(region);
    if (region.startsWith('us-gov-')) return `https://q.${region}.amazonaws.com`;
    if (region === 'us-iso-east-1') return 'https://q.us-iso-east-1.c2s.ic.gov';
    if (region === 'us-isob-east-1') return 'https://q.us-isob-east-1.sc2s.sgov.gov';
    if (region === 'us-isof-south-1') return 'https://q.us-isof-south-1.csp.hci.ic.gov';
    if (region === 'us-isof-east-1') return 'https://q.us-isof-east-1.csp.hci.ic.gov';
    if (region === 'eu-central-1') return 'https://q.eu-central-1.amazonaws.com';
    if (region === 'us-east-1') return 'https://codewhisperer.us-east-1.amazonaws.com';
    throw new CollectorError(`Kiro quota service is unavailable in region ${region}.`, 'auth-invalid');
}

export function kiroUsageUrl(auth: KiroRoute): string {
    const query = ['origin=CLI'];
    if (auth.profileArn) query.unshift(`profileArn=${encodeURIComponent(auth.profileArn)}`);
    return `${kiroServiceEndpoint(auth.region)}/?${query.join('&')}`;
}
