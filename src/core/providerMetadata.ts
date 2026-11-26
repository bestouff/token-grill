import type {AccentColor, AccountApp, CanonicalQuotaWindow, ProviderKind} from './types.js';

interface ProviderMetadata {
    label: string;
    defaultAccent: AccentColor;
    iconFile: string;
    quotaWindows: CanonicalQuotaWindow[];
    localHistorySupported: boolean;
    // The apps an account can be read from; the first is the default.
    apps: readonly [AccountApp, ...AccountApp[]];
    measure: 'limits' | 'balance';
}

const PROVIDER_METADATA: Record<ProviderKind, ProviderMetadata> = {
    codex: {
        label: 'Codex',
        defaultAccent: 'green',
        iconFile: 'codex-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly'],
        localHistorySupported: true,
        apps: ['codex-cli', 'opencode'],
        measure: 'limits',
    },
    claude: {
        label: 'Claude',
        defaultAccent: 'orange',
        iconFile: 'claude-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly'],
        localHistorySupported: true,
        apps: ['claude-code', 'opencode'],
        measure: 'limits',
    },
    kiro: {
        label: 'Kiro',
        defaultAccent: 'purple',
        iconFile: 'kiro-symbolic.svg',
        quotaWindows: ['monthly'],
        localHistorySupported: false,
        apps: ['kiro-cli'],
        measure: 'limits',
    },
    antigravity: {
        label: 'Antigravity',
        defaultAccent: 'teal',
        iconFile: 'antigravity-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly'],
        localHistorySupported: false,
        apps: ['antigravity'],
        measure: 'limits',
    },
    copilot: {
        label: 'Copilot',
        defaultAccent: 'slate',
        iconFile: 'copilot-symbolic.svg',
        quotaWindows: ['monthly'],
        localHistorySupported: false,
        apps: ['github-cli', 'copilot-cli', 'opencode'],
        measure: 'limits',
    },
    'opencode-go': {
        label: 'OpenCode Go',
        defaultAccent: 'yellow',
        iconFile: 'opencode-go-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly', 'monthly'],
        localHistorySupported: false,
        apps: ['opencode'],
        measure: 'limits',
    },
    deepseek: {
        label: 'DeepSeek',
        defaultAccent: 'blue',
        iconFile: 'deepseek-symbolic.svg',
        quotaWindows: [],
        localHistorySupported: false,
        apps: ['keyring', 'opencode', 'claude-settings'],
        measure: 'balance',
    },
    kimi: {
        label: 'Kimi Code',
        defaultAccent: 'pink',
        iconFile: 'kimi-symbolic.svg',
        quotaWindows: ['five-hour', 'weekly', 'monthly'],
        localHistorySupported: false,
        apps: ['kimi-cli', 'opencode'],
        measure: 'limits',
    },
    cursor: {
        label: 'Cursor',
        defaultAccent: 'slate',
        iconFile: 'cursor-symbolic.svg',
        quotaWindows: ['monthly'],
        localHistorySupported: false,
        apps: ['cursor', 'cursor-agent'],
        measure: 'limits',
    },
};

export function providerMetadata(kind: ProviderKind): ProviderMetadata {
    return PROVIDER_METADATA[kind];
}

export function providerIconFile(kind: ProviderKind): string {
    return providerMetadata(kind).iconFile;
}
