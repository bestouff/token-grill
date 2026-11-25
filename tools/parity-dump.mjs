// Writes the 0.4.1 output of every service normalizer for the parity inputs.
// Usage: node tools/parity-dump.mjs <build/tests folder of a v0.4.1 checkout>
// Temporary: removed with the fixtures once 0.5.0 is released.
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const bundleDir = process.argv[2];
if (!bundleDir) {
    console.error('usage: node tools/parity-dump.mjs <build/tests folder>');
    process.exit(2);
}
const parityDir = path.join(process.cwd(), 'service', 'tests', 'parity');

const load = name => import(pathToFileURL(path.resolve(bundleDir, `${name}.mjs`)).href);

// kind -> [bundle, call]. "now" is passed explicitly wherever 0.4.1 reads the clock.
const KINDS = {
    codex: {
        usage: ['codex-normalize', m => c => m.normalizeCodexUsage(c.payload)],
        reset_credits: ['reset-credits-normalize', m => c => m.normalizeResetCredits(c.payload, c.now)],
        usage_event: ['codex-history', m => c => m.codexUsageEvent(c.payload)],
    },
    claude: {
        usage: ['claude-normalize', m => c => m.normalizeClaudeUsage(c.payload)],
        usage_event: ['claude-history', m => c => m.claudeUsageEvent(c.payload)],
    },
    kiro: {
        usage: ['kiro-normalize', m => c => m.normalizeKiroUsage(c.payload)],
    },
    antigravity: {
        plan: ['antigravity-normalize', m => c => m.antigravityPlan(c.payload)],
        buckets: ['antigravity-normalize', m => c => m.extractQuotaSummaryBuckets(c.payload)],
        usage: ['antigravity-normalize', m => c => m.normalizeQuotaSummary(c.payload)],
    },
    copilot: {
        usage: ['copilot-normalize', m => c => m.normalizeCopilotUsage(c.payload)],
    },
    opencode_go: {
        usage: ['opencode-go-normalize', m => c => m.normalizeOpenCodeGoUsage(c.payload)],
    },
    deepseek: {
        balance: ['deepseek-normalize', m => c => m.normalizeDeepSeekBalance(c.payload)],
        claude_settings_key: ['deepseek-normalize', m => c => m.deepSeekKeyFromClaudeSettings(c.payload)],
    },
    kimi: {
        usage: ['kimi-normalize', m => c => m.normalizeKimiUsage(c.payload)],
        api_host: ['kimi-normalize', m => c => m.kimiApiHost(c.payload)],
    },
    cursor: {
        usage: ['cursor-normalize', m => c => m.normalizeCursorUsage(c.payload)],
        plan: ['cursor-normalize', m => c => m.normalizeCursorPlan(c.payload)],
        is_jwt_like: ['cursor-normalize', m => c => m.isJwtLike(c.payload)],
    },
};

// A normalizer that throws a CollectorError is compared by its code.
function run(call, testCase) {
    try {
        const value = call(testCase);
        return {value: value === undefined ? null : value};
    } catch (error) {
        if (error && typeof error.code === 'string')
            return {error: error.code};
        throw error;
    }
}

await mkdir(path.join(parityDir, 'expected'), {recursive: true});
for (const file of (await readdir(path.join(parityDir, 'inputs'))).filter(name => name.endsWith('.json')).sort()) {
    const service = file.replace(/\.json$/, '');
    const cases = JSON.parse(await readFile(path.join(parityDir, 'inputs', file), 'utf8'));
    const kinds = KINDS[service];
    if (!kinds)
        throw new Error(`no parity kinds for ${service}`);
    const expected = {};
    for (const testCase of cases) {
        const entry = kinds[testCase.kind];
        if (!entry)
            throw new Error(`${service}: unknown kind ${testCase.kind}`);
        if (testCase.name in expected)
            throw new Error(`${service}: duplicate case ${testCase.name}`);
        expected[testCase.name] = run(entry[1](await load(entry[0])), testCase);
    }
    await writeFile(path.join(parityDir, 'expected', file), `${JSON.stringify(expected, null, 2)}\n`);
    console.log(`${service}: ${cases.length} cases`);
}
