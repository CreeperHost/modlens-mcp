// Real HTTP MCP transport and shipped uploader smoke. Uses a disposable server/cache on loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'modlens-http-smoke-'));
const listener = createServer();
listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolveClose => listener.close(resolveClose));
const endpoint = `http://127.0.0.1:${port}/mcp`;
const keyFile = process.argv[3] ?? join(root, 'key.txt');
const bundlePath = process.argv[2] ?? join(root, 'environment.zip');
const target = process.argv[4] ?? 'example.Target';
const key = process.argv[3] ? (await readFile(keyFile, 'utf8')).trim() : randomBytes(32).toString('hex');
if (!process.argv[2]) {
    await writeFile(keyFile, `${key}\n`);
    const jar = new AdmZip();
    jar.addFile('example/Target.class', Buffer.from('test class entry'));
    jar.addFile('example/Target.java', Buffer.from('package example; public class Target { public int counter; }'));
    // An incompressible payload exercises multiple full upload chunks.
    jar.addFile('payload.bin', randomBytes(2 * 1024 * 1024));
    const bytes = jar.toBuffer();
    const bundle = new AdmZip();
    bundle.addFile('artifacts/0.jar', bytes);
    bundle.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'modlens-project-v1', project: 'http-smoke:', sourceSet: 'main',
        toolchain: 'gradle-compile-classpath', minecraftVersion: '', loaderVersion: '', mappings: 'compile-classpath', javaVersion: 21, transformations: [],
        artifacts: [{ path: 'artifacts/0.jar', name: 'prepared.jar', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'classpath' }] })));
    await writeFile(bundlePath, bundle.toBuffer());
}
const env = { ...process.env, MCP_PORT: String(port), MCP_HOST: '127.0.0.1', MODLENS_AUTO_EMBED: '0',
    MODLENS_CACHE_ROOT: join(root, 'cache'), MODLENS_HOME: root, DATABASE_URL: `file:${join(root, 'unused.db')}`, MODLENS_VERBOSE: '1' };
const server = spawn(process.execPath, [join(repo, 'dist/server.js')], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = '';
server.stderr.on('data', b => { logs += b; });
const stopped = once(server, 'exit');
const client = new Client({ name: 'project-http-test', version: '1.0.0' });
let passed = false;
try {
    await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('HTTP server startup timed out')), 30_000);
        const ready = () => { if (logs.includes('listening on')) { clearTimeout(timer); server.stderr.off('data', ready); resolveReady(); } };
        server.stderr.on('data', ready);
        server.once('error', reject);
        server.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited before startup: ${logs}`)); });
        ready();
    });
    const uploader = spawn(process.execPath, [join(repo, 'scripts/project-upload.mjs'), endpoint, bundlePath, keyFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    uploader.stdout.on('data', b => { output += b; }); uploader.stderr.on('data', b => { error += b; });
    const [code] = await once(uploader, 'exit');
    assert.equal(code, 0, error);
    assert.ok(!output.includes(key), 'uploader must not print project key');
    const imported = JSON.parse(output);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const call = (action, args = {}) => client.callTool({ name: 'project', arguments: { action, projectKey: key, environmentId: imported.environmentId, ...args } }, undefined, { timeout: 300_000 });
    const tools = await client.listTools();
    assert.ok(tools.tools.some(t => t.name === 'project'));
    const source = await call('source', { className: target });
    assert.ok(!source.isError, JSON.stringify(source));
    assert.ok(JSON.parse(source.content[0].text).source.length > 0);
    if (process.argv[5]) {
        const members = await call('members', { className: target });
        assert.ok(!members.isError, JSON.stringify(members));
        const field = JSON.parse(members.content[0].text).result.fields.find(f => f.name === process.argv[5]);
        assert.equal(field?.access, 1, 'remote member view must preserve the public, non-final AT result');
        const searched = await call('search', { query: `public boolean ${process.argv[5]}`, limit: 200 });
        assert.ok(!searched.isError, JSON.stringify(searched));
        assert.ok(JSON.parse(searched.content[0].text).results.some(r => r.className === target.replaceAll('.', '/')));
    }
    const wrongKey = await call('info', { projectKey: randomBytes(32).toString('hex') });
    assert.ok(wrongKey.isError);
    const local = await call('import_local', { bundlePath });
    assert.ok(local.isError, 'HTTP must reject host-local import');
    const failedChunk = await call('upload_chunk', { uploadId: 'f'.repeat(64), offset: 0, data: 'SENSITIVE_PAYLOAD' });
    assert.ok(failedChunk.isError);
    const large = await fetch(endpoint, { method: 'POST', body: 'x'.repeat(9 * 1024 * 1024) });
    assert.equal(large.status, 413);
    assert.ok(!logs.includes(key), 'server logs must redact project key');
    assert.ok(!logs.includes('SENSITIVE_PAYLOAD'), 'server logs must redact upload bytes');
    console.log(`PASS: HTTP upload, ${imported.classCount} classes, source query, project isolation, host-path rejection, body limits and log redaction`);
    passed = true;
} finally {
    await client.close();
    server.kill(); await stopped;
    if (passed) await rm(root, { recursive: true, force: true });
    else console.log(`HTTP fixture retained: ${root}`);
}
