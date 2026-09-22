// Opt-in regression against real, immutable release JARs and live evidence APIs.
// Downloads test artifacts only; no credentials, ingestion or bulk source export.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import AdmZip from 'adm-zip';
import { inspectModLicense } from '../dist/mod-license.js';

const root = resolve('.scratch/license-live');
await mkdir(root, { recursive: true });
const cases = [
    { name: 'JEI', version: 'JhEb3Vl1', hash: 'a9418a15032d1653b4776763f2df7c54544a1c2314fe1c4269ba60d9bb51a204', license: 'MIT', target: 'mezz.jei.common.Constants' },
    { name: 'Jade', version: 'yd8FKCmx', hash: '067bb4b007e1d6f6b79f0afe99c91252aa825472b99a76d33a60d24442f9e92d', license: 'CC-BY-NC-SA-4.0', target: 'snownee.jade.Jade' },
    { name: 'Embeddium', version: 'UTbfe5d1', hash: 'eed3d1325f2acc2fd4e69bb495e5ccb91d962126ac5330f0582ebc2a3daf47fb', license: 'LGPL-3.0-only', target: 'org.embeddedt.embeddium.api.EmbeddiumConstants' },
];
if (process.argv.includes('--corpus')) {
    cases.push(...JSON.parse(await readFile(new URL('./fixtures/mod-license-corpus.json', import.meta.url), 'utf8')));
}
const outcomes = [];
const digest = data => createHash('sha256').update(data).digest('hex');
for (const item of cases) {
    const outcome = { name: item.name, version: item.version, expected: item.expected ?? 'hosted_allowed' };
    outcomes.push(outcome);
    try {
    const jar = join(root, `${item.name}.jar`);
    let data = await readFile(jar).catch(() => null);
    if (!data || digest(data) !== item.hash) {
        const response = await fetch(`https://api.modrinth.com/v2/version/${item.version}`, { headers: { 'User-Agent': 'modlens-mcp/license-regression' } });
        assert.equal(response.status, 200);
        const version = await response.json();
        const url = new URL(version.files.find(f => f.primary)?.url ?? version.files[0].url);
        assert.equal(url.origin, 'https://cdn.modrinth.com');
        const download = await fetch(url, { redirect: 'error' });
        assert.equal(download.status, 200);
        data = Buffer.from(await download.arrayBuffer());
        assert.equal(digest(data), item.hash, `${item.name} exact artifact`);
        await writeFile(jar, data);
    }
    const decision = await inspectModLicense(jar);
    await writeFile(join(root, `${item.name}.decision.json`), JSON.stringify(decision, null, 2));
    Object.assign(outcome, { actual: decision.disposition, license: decision.selectedLicense, origin: decision.selectedOrigin, reason: decision.reason, notices: decision.notices.length });
    assert.equal(decision.disposition, outcome.expected, `${item.name}: ${decision.reason}`);
    if (decision.disposition === 'hosted_allowed') {
        assert.equal(decision.selectedLicense, item.license);
        assert.ok(decision.notices.length);
    }
    if (item.name === 'Jade') assert.equal(decision.conditions.noncommercialOnly, true);
    if (item.name === 'Embeddium') {
        assert.ok(decision.conditions.sourceArchive?.includes('87d1a75'));
        assert.ok(decision.notices.some(n => n.name.includes('COPYING.LESSER')));
        assert.ok(decision.notices.some(n => n.name.startsWith('dependency/')));
        const response = await fetch(decision.conditions.sourceArchive, { method: 'HEAD' });
        assert.equal(response.status, 200, 'complete corresponding-source archive is available');
    }
    if (process.argv.includes('--http') && decision.disposition === 'hosted_allowed' && item.target) {
        const bundle = new AdmZip();
        bundle.addFile('artifacts/0.jar', data);
        bundle.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'modlens-project-v1', project: `license-${item.name}:`, sourceSet: 'main',
            toolchain: 'gradle-compile-classpath', minecraftVersion: '', loaderVersion: '', mappings: 'compile-classpath', javaVersion: 21, transformations: [],
            artifacts: [{ path: 'artifacts/0.jar', name: `${item.name}.jar`, size: data.length, sha256: item.hash, kind: 'classpath' }] })));
        const bundlePath = join(root, `${item.name}.zip`), keyPath = join(root, `${item.name}.key`);
        await writeFile(bundlePath, bundle.toBuffer());
        await writeFile(keyPath, createHash('sha256').update(`disposable-test-${item.hash}`).digest('hex'));
        const child = spawn(process.execPath, ['scripts/test-project-http.mjs', bundlePath, keyPath, item.target], { stdio: 'inherit',
            env: { ...process.env, MODLENS_TEST_EXPECTED_LICENSE: item.license } });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, `${item.name} real HTTP hosted source path`);
        outcome.http = 'passed';
    } else if (process.argv.includes('--http')) {
        outcome.http = decision.disposition === 'hosted_allowed' ? 'not run: no root class target' : 'not run: local-only decision';
    }
    outcome.passed = true;
    console.log(`PASS: ${item.name}: ${decision.disposition}, ${decision.selectedLicense ?? 'no selected licence'} from ${decision.selectedOrigin ?? 'no selected origin'}, ${decision.notices.length} complete notices`);
    } catch (error) {
        outcome.passed = false;
        outcome.error = error instanceof Error ? error.message : String(error);
        console.error(`FAIL: ${item.name}: ${outcome.error}`);
    }
}
const summary = { checkedAt: new Date().toISOString(), total: outcomes.length, passed: outcomes.filter(o => o.passed).length, failed: outcomes.filter(o => !o.passed).length, outcomes };
await writeFile(join(root, process.argv.includes('--corpus') ? 'corpus-results.json' : 'baseline-results.json'), JSON.stringify(summary, null, 2));
console.log(`Licence corpus: ${summary.passed}/${summary.total} passed; ${summary.failed} failed.`);
if (summary.failed) process.exitCode = 1;
