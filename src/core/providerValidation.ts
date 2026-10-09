export interface ProviderValidationErrors {
    displayName?: string;
    accountHome?: string;
    authFileOverride?: string;
    sessionsDirectoryOverride?: string;
}

export interface ProviderValidationResult {
    valid: boolean;
    errors: ProviderValidationErrors;
}

export interface ProviderDraftPaths {
    kind?: string;
    id?: string;
    displayName: string;
    accountHome: string;
    authFileOverride?: string | null;
    sessionsDirectoryOverride?: string | null;
}

export interface ExistingProviderPath {
    kind?: string;
    id: string;
    accountHome: string;
}

type CanonicalizePath = (value: string) => string;

function pathError(value: string | null | undefined, canonicalize: CanonicalizePath): string | null {
    if (!value?.trim()) return null;
    try {
        canonicalize(value);
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

export function validateProviderDraft(
    draft: ProviderDraftPaths,
    providers: ExistingProviderPath[],
    canonicalize: CanonicalizePath,
): ProviderValidationResult {
    const errors: ProviderValidationErrors = {};

    if (!draft.displayName.trim())
        errors.displayName = 'Display name is required.';

    let canonicalHome: string | null = null;
    try {
        canonicalHome = canonicalize(draft.accountHome);
    } catch (error) {
        errors.accountHome = error instanceof Error ? error.message : String(error);
    }

    if (canonicalHome !== null) {
        const duplicate = providers.some(provider => {
            if (provider.id === draft.id) return false;
            if (provider.kind && draft.kind && provider.kind !== draft.kind) return false;
            try {
                return canonicalize(provider.accountHome) === canonicalHome;
            } catch {
                return false;
            }
        });
        if (duplicate)
            errors.accountHome = 'Another provider already uses this account home.';
    }

    const authError = pathError(draft.authFileOverride, canonicalize);
    if (authError) errors.authFileOverride = authError;
    const sessionsError = pathError(draft.sessionsDirectoryOverride, canonicalize);
    if (sessionsError) errors.sessionsDirectoryOverride = sessionsError;

    return {valid: Object.keys(errors).length === 0, errors};
}

export function firstProviderValidationError(result: ProviderValidationResult): string | null {
    return result.errors.displayName || result.errors.accountHome || result.errors.authFileOverride ||
        result.errors.sessionsDirectoryOverride || null;
}
