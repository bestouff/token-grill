// Texts that Preferences show about an account.
import type {Translator} from './i18n.js';
import {providerMetadata} from './providerMetadata.js';
import type {ProviderKind} from './types.js';

// The state names that the service reports. Null for a state that a newer service reports and
// this version has no words for.
export function credentialLabel(tr: Translator, state: string): string | null {
    const {_} = tr;
    switch (state) {
    case 'authenticated':
        return _('Authenticated');
    case 'expired':
        return _('Sign-in expired');
    case 'expired-refreshable':
        return _('Sign-in expired, renewed automatically');
    case 'expired-external':
        return _('Token expired; run any agy command to refresh');
    case 'login-required':
        return _('Sign-in required');
    case 'unreadable':
        return _('Credential unreadable');
    case 'database-unreadable':
        return _('Database unreadable');
    case 'keyring-unavailable':
        return _('System keyring locked or unavailable');
    default:
        return null;
    }
}

// A second Codex or Claude account lives in its own home such as ~/.codex-work,
// so the suffix is the only name it has. Other folders keep the service name.
export function homeName(kind: ProviderKind, folder: string): string {
    const label = providerMetadata(kind).label;
    const prefix = `.${kind}`;
    return folder.startsWith(prefix) && folder !== prefix ? `${label}${folder.slice(prefix.length)}` : label;
}
