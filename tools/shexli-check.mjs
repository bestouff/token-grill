import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {readFile} from 'node:fs/promises';

const root = process.cwd();
const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
const targets = [
    path.join(root, 'dist', metadata.uuid),
    path.join(root, 'build', 'releases', `${metadata.uuid}.shell-extension.zip`),
];

let failed = false;
for (const target of targets) {
    const result = spawnSync('uvx', [
        '--python', '3.12',
        '--from', 'shexli==0.2.1',
        '--with', 'tree-sitter==0.25.2',
        'shexli', '--format', 'json', target,
    ], {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
    const label = path.relative(root, target);
    if (result.error) {
        console.error(`${label}: could not run Shexli: ${result.error.message}`);
        failed = true;
        continue;
    }
    if (result.status !== 0) {
        console.error(`${label}: Shexli exited with status ${result.status}.`);
        if (result.stderr.trim()) console.error(result.stderr.trim());
        failed = true;
        continue;
    }
    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        console.error(`${label}: Shexli did not return valid JSON.`);
        if (result.stdout.trim()) console.error(result.stdout.trim());
        failed = true;
        continue;
    }
    const findingCount = report.finding_count ?? report.summary?.finding_count;
    if (!Number.isInteger(findingCount)) {
        console.error(`${label}: Shexli JSON did not contain finding_count.`);
        failed = true;
    } else if (findingCount > 0) {
        console.error(`${label}: ${findingCount} Shexli finding${findingCount === 1 ? '' : 's'}.`);
        for (const finding of report.findings || [])
            console.error(`  ${finding.code || finding.rule_id || 'unknown'}: ${finding.message || finding.title || 'review finding'}`);
        failed = true;
    } else {
        console.log(`${label}: Shexli review clean.`);
    }
}

if (failed) process.exitCode = 1;
