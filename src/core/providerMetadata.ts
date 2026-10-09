import type {AccentColor, CanonicalQuotaWindow, ProviderKind, QuotaWindowPreference} from './types.js';

export interface ProviderMetadata {
    label: string;
    defaultAccountHome: string;
    defaultAccent: AccentColor;
    iconFile: string;
    darkIconFile: string;
    quotaWindows: CanonicalQuotaWindow[];
    defaultQuotaWindow: QuotaWindowPreference;
    localHistorySupported: boolean;
    loginCommand: string | null;
}

export const PROVIDER_METADATA: Record<ProviderKind, ProviderMetadata> = {
    codex: {
        label: 'Codex',
        defaultAccountHome: '~/.codex',
        defaultAccent: 'green',
        iconFile: 'openai-blossom-light.svg',
        darkIconFile: 'openai-blossom-dark.svg',
        quotaWindows: ['five-hour', 'weekly'],
        defaultQuotaWindow: 'automatic',
        localHistorySupported: true,
        loginCommand: 'codex login',
    },
    claude: {
        label: 'Claude',
        defaultAccountHome: '~/.claude',
        defaultAccent: 'orange',
        iconFile: 'claude-mark-light.svg',
        darkIconFile: 'claude-mark-dark.svg',
        quotaWindows: ['five-hour', 'weekly'],
        defaultQuotaWindow: 'automatic',
        localHistorySupported: true,
        loginCommand: 'claude auth login',
    },
    kiro: {
        label: 'Kiro',
        defaultAccountHome: '$XDG_DATA_HOME/kiro-cli',
        defaultAccent: 'purple',
        iconFile: 'kiro-icon.png',
        darkIconFile: 'kiro-icon.png',
        quotaWindows: ['monthly'],
        defaultQuotaWindow: 'monthly',
        localHistorySupported: false,
        loginCommand: 'kiro-cli login',
    },
    antigravity: {
        label: 'Antigravity',
        defaultAccountHome: '~/.antigravity',
        defaultAccent: 'cyan',
        iconFile: 'antigravity-mark-light.svg',
        darkIconFile: 'antigravity-mark-dark.svg',
        quotaWindows: ['five-hour', 'weekly'],
        defaultQuotaWindow: 'automatic',
        localHistorySupported: false,
        loginCommand: null,
    },
};

export function providerMetadata(kind: ProviderKind): ProviderMetadata {
    return PROVIDER_METADATA[kind];
}

export function providerIconFile(kind: ProviderKind, appearance: 'light' | 'dark' = 'light'): string {
    const metadata = providerMetadata(kind);
    return appearance === 'dark' ? metadata.darkIconFile : metadata.iconFile;
}
