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

// PRACTICES T-2: Shexli 0.2.1 rejects every major above 50, and the Shexli on EGO no longer does.
const staleShellVersion = finding => finding.rule_id === 'EGO-M-004' &&
    metadata['shell-version'].every(version => /^\d+$/.test(version) && Number(version) <= 51);

// PRACTICES LE-6: the clipboard use of the setup Copy button is declared in the metadata description.
const clipboardCopy = finding => finding.rule_id === 'EGO-A-005' &&
    JSON.stringify(finding).includes('shell/serviceCard.js');

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
    // Shexli 0.2.1 always exits 0, so the JSON summary is the only verdict.
    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        console.error(`${label}: Shexli did not return valid JSON.`);
        console.error(result.stderr.trim() || result.stdout.trim());
        failed = true;
        continue;
    }
    if (!Number.isInteger(report.summary.finding_count)) {
        console.error(`${label}: Shexli JSON did not contain finding_count.`);
        failed = true;
        continue;
    }
    const isAccepted = finding => staleShellVersion(finding) || clipboardCopy(finding);
    const accepted = report.findings.filter(isAccepted);
    const findings = report.findings.filter(finding => !isAccepted(finding));
    if (findings.length > 0) {
        console.error(`${label}: ${findings.length} Shexli finding${findings.length === 1 ? '' : 's'}.`);
        for (const finding of findings)
            console.error(`  ${finding.rule_id}: ${finding.message}`);
        failed = true;
    } else if (accepted.length > 0) {
        console.log(`${label}: Shexli review clean, except EGO-M-004 for GNOME 51 (accepted, PRACTICES T-2).`);
    } else {
        console.log(`${label}: Shexli review clean.`);
    }
}

if (failed)
    process.exitCode = 1;
