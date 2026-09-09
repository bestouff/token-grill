import {mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root = process.cwd();
const out = path.join(root, 'build', 'tests');
await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});
for (const [source, name] of [
    ['src/providers/codex/normalize.ts', 'codex-normalize.mjs'],
    ['src/providers/claude/normalize.ts', 'claude-normalize.mjs'],
    ['src/providers/kiro/normalize.ts', 'kiro-normalize.mjs'],
    ['src/providers/kiro/endpoints.ts', 'kiro-endpoints.mjs'],
    ['src/providers/kiro/authRecords.ts', 'kiro-auth-records.mjs'],
    ['src/providers/antigravity/normalize.ts', 'antigravity-normalize.mjs'],
    ['src/providers/antigravity/endpoints.ts', 'antigravity-endpoints.mjs'],
    ['src/core/providerMetadata.ts', 'provider-metadata.mjs'],
    ['src/core/providerValidation.ts', 'provider-validation.mjs'],
    ['src/providers/codex/resetCreditsNormalize.ts', 'reset-credits-normalize.mjs'],
    ['src/core/timeMath.ts', 'time-math.mjs'],
    ['src/core/notificationPolicy.ts', 'notification-policy.mjs'],
    ['src/core/accent.ts', 'accent.mjs'],
    ['src/core/providerOrder.ts', 'provider-order.mjs'],
    ['src/core/historyMetrics.ts', 'history-metrics.mjs'],
]) {
    execFileSync(path.join(root, 'node_modules', '.bin', 'esbuild'), [source, '--bundle', '--format=esm', '--platform=node', `--outfile=${path.join(out, name)}`], {cwd: root, stdio: 'inherit'});
}
