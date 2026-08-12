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
    },
};

export function providerMetadata(kind: ProviderKind): ProviderMetadata {
    return PROVIDER_METADATA[kind];
}

export function providerIconFile(kind: ProviderKind, appearance: 'light' | 'dark' = 'light'): string {
    const metadata = providerMetadata(kind);
    return appearance === 'dark' ? metadata.darkIconFile : metadata.iconFile;
}
