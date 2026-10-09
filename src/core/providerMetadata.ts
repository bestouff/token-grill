import type {AccentColor, CanonicalQuotaWindow, ProviderKind, QuotaWindowPreference} from './types.js';

export interface ProviderMetadata {
    label: string;
    defaultAccountHome: string;
    defaultAccent: AccentColor;
    iconFile: string;
    darkIconFile: string;
    symbolicIconFile: string;
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
        iconFile: 'openai-mono-light.svg',
        darkIconFile: 'openai-mono-dark.svg',
        symbolicIconFile: 'openai-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly'],
        defaultQuotaWindow: 'automatic',
        localHistorySupported: true,
        loginCommand: 'codex login',
    },
    claude: {
        label: 'Claude',
        defaultAccountHome: '~/.claude',
        defaultAccent: 'orange',
        iconFile: 'claude-mono-light.svg',
        darkIconFile: 'claude-mono-dark.svg',
        symbolicIconFile: 'claude-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly'],
        defaultQuotaWindow: 'automatic',
        localHistorySupported: true,
        loginCommand: 'claude auth login',
    },
    kiro: {
        label: 'Kiro',
        defaultAccountHome: '$XDG_DATA_HOME/kiro-cli',
        defaultAccent: 'purple',
        iconFile: 'kiro-mono-light.svg',
        darkIconFile: 'kiro-mono-dark.svg',
        symbolicIconFile: 'kiro-symbolic.svg',
        quotaWindows: ['monthly'],
        defaultQuotaWindow: 'monthly',
        localHistorySupported: false,
        loginCommand: 'kiro-cli login',
    },
    antigravity: {
        label: 'Antigravity',
        defaultAccountHome: '~/.antigravity',
        defaultAccent: 'cyan',
        iconFile: 'antigravity-mono-light.svg',
        darkIconFile: 'antigravity-mono-dark.svg',
        symbolicIconFile: 'antigravity-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly'],
        defaultQuotaWindow: 'automatic',
        localHistorySupported: false,
        loginCommand: null,
    },
    deepseek: {
        label: 'DeepSeek', defaultAccountHome: '$XDG_DATA_HOME/opencode', defaultAccent: 'blue',
        iconFile: 'deepseek-mono-light.svg', darkIconFile: 'deepseek-mono-dark.svg',
        symbolicIconFile: 'deepseek-symbolic.svg',
        quotaWindows: [], defaultQuotaWindow: 'automatic', localHistorySupported: false,
        loginCommand: 'opencode auth login',
    },
    kimi: {
        label: 'Kimi Code', defaultAccountHome: '~/.kimi-code', defaultAccent: 'pink',
        iconFile: 'kimi-mono-light.svg', darkIconFile: 'kimi-mono-dark.svg',
        symbolicIconFile: 'kimi-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly', 'monthly'], defaultQuotaWindow: 'automatic',
        localHistorySupported: false, loginCommand: 'kimi',
    },
    opencode: {
        label: 'OpenCode Zen / Go', defaultAccountHome: '$XDG_DATA_HOME/opencode', defaultAccent: 'amber',
        iconFile: 'opencode-mono-light.svg', darkIconFile: 'opencode-mono-dark.svg',
        symbolicIconFile: 'opencode-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly', 'monthly'], defaultQuotaWindow: 'automatic',
        localHistorySupported: false, loginCommand: 'opencode auth login',
    },
};

export function providerMetadata(kind: ProviderKind): ProviderMetadata {
    return PROVIDER_METADATA[kind];
}

export function providerIconFile(kind: ProviderKind, appearance: 'light' | 'dark' | 'symbolic' = 'symbolic'): string {
    const metadata = providerMetadata(kind);
    if (appearance === 'symbolic') return metadata.symbolicIconFile;
    return appearance === 'dark' ? metadata.darkIconFile : metadata.iconFile;
}
