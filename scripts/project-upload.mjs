#!/usr/bin/env node
// Transfer a Gradle export over MCP without exposing a local filesystem path to the server.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, open, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [endpoint, bundlePath, keyFile] = process.argv.slice(2);
if (!endpoint || !bundlePath || !keyFile || process.argv.length !== 5) {
    console.error('Usage: node scripts/project-upload.mjs <https://host/mcp> <environment.zip> <project-key.txt>');
    process.exit(1);
}
const url = new URL(endpoint);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS for remote project uploads (HTTP is allowed only on loopback).');
}
if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint must not contain credentials, query parameters or a fragment. Use MODLENS_AUTH_TOKEN for proxy authentication.');
const projectKey = (await readFile(keyFile, 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(projectKey)) throw new Error('Invalid project key file');
const size = (await stat(bundlePath)).size;
if (!size || size > 512 * 1024 * 1024) throw new Error('Bundle must contain 1 byte to 512 MiB');
const hash = createHash('sha256');
for await (const chunk of createReadStream(bundlePath)) hash.update(chunk);
const client = new Client({ name: 'modlens-project-upload', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url, { requestInit: {
    // Never follow redirects carrying the private project capability in the request body.
    redirect: 'error',
    headers: process.env.MODLENS_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.MODLENS_AUTH_TOKEN}` } : {},
} });
let uploadId;
try {
    await client.connect(transport);
    const call = async (args) => {
        const response = await client.callTool({ name: 'project', arguments: { ...args, projectKey } }, undefined, { timeout: 300_000 });
        const text = response.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (response.isError) throw new Error(text || 'Project upload failed');
        return JSON.parse(text);
    };
    const begin = await call({ action: 'upload_begin', size, sha256: hash.digest('hex') });
    uploadId = begin.uploadId;
    const file = await open(bundlePath, 'r');
    try {
        let offset = 0;
        while (offset < size) {
            const bytes = Buffer.alloc(Math.min(begin.chunkBytes, size - offset));
            const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
            if (bytesRead !== bytes.length) throw new Error('Bundle changed during upload; re-export it.');
            // Retrying an acknowledged range is checked byte-for-byte by the server.
            let result;
            for (let attempt = 0; attempt < 3; attempt++) {
                try { result = await call({ action: 'upload_chunk', uploadId, offset, data: bytes.toString('base64') }); break; }
                catch (error) { if (attempt === 2) throw error; }
            }
            if (result.offset !== offset + bytes.length) throw new Error('Unexpected upload offset');
            offset = result.offset;
        }
    } finally { await file.close(); }
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await call({ action: 'upload_finish', uploadId }); break; }
        catch (error) { if (attempt === 2) throw error; }
    }
    console.log(JSON.stringify(result, null, 2));
    await call({ action: 'upload_abort', uploadId }); // receipt no longer needed
    uploadId = undefined;
} catch (error) {
    if (uploadId) {
        try { await client.callTool({ name: 'project', arguments: { action: 'upload_abort', projectKey, uploadId } }); } catch { }
    }
    // Do not print transport objects or request bodies, which contain the project capability.
    console.error(`Project upload failed: ${String(error.message).split(projectKey).join('[redacted]')}`);
    process.exitCode = 1;
} finally { await client.close(); }
