import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'modlens-oauth-test-'));
const entry = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const port = async () => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const value = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return value;
};
const providerPort = await port();
const mcpPort = await port();
const issuer = `http://127.0.0.1:${providerPort}`;
const resource = `http://127.0.0.1:${mcpPort}/mcp`;
const profiles = new Map();
let partner = true;
let subject = 'customer:42';
let serial = 0;
let metadataRequests = 0;
const provider = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const write = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/.well-known/oauth-authorization-server') {
        if (++metadataRequests === 1) return write(503, { error: 'temporarily_unavailable', access_token: 'metadata-secret' });
        return write(200, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
            authorization_response_iss_parameter_supported: true });
    }
    if (url.pathname === '/authorize') {
        const callback = new URL(url.searchParams.get('redirect_uri'));
        callback.searchParams.set('code', 'fake-code');
        callback.searchParams.set('state', url.searchParams.get('state'));
        callback.searchParams.set('iss', issuer);
        res.writeHead(302, { Location: callback.toString() }); res.end(); return;
    }
    if (url.pathname === '/token') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const data = new URLSearchParams(raw);
        if (data.get('grant_type') === 'refresh_token' && !data.get('refresh_token')?.startsWith('upstream-refresh-'))
            return write(400, { error: 'invalid_grant' });
        if (data.get('grant_type') === 'authorization_code' && data.get('code') !== 'fake-code')
            return write(400, { error: 'invalid_grant' });
        const access = `upstream-${++serial}`;
        profiles.set(access, { sub: subject, is_partner: partner });
        return write(200, { access_token: access, refresh_token: `upstream-refresh-${serial}`, token_type: 'Bearer', expires_in: 300 });
    }
    if (url.pathname === '/profile') {
        const profile = profiles.get(req.headers.authorization?.slice(7));
        return profile ? write(200, { ...profile, is_partner: partner }) : write(401, { error: 'invalid_token' });
    }
    write(404, {});
});
provider.listen(providerPort, '127.0.0.1');
await once(provider, 'listening');
const env = { ...process.env, MCP_PORT: String(mcpPort), MCP_HOST: '127.0.0.1',
    MODLENS_HOME: root, MODLENS_CACHE_ROOT: join(root, 'cache'), DATABASE_URL: `file:${join(root, 'oauth.db')}`,
    MODLENS_AUTO_EMBED: '0', MODLENS_AUTO_GRAPH: '0', MODLENS_HOSTED_LIMITS: '1', MODLENS_HOSTED_AUTH: 'oauth',
    MODLENS_HOSTED_PROXY_SECRET: '', MODLENS_HOSTED_MC_SOURCE: '0', MODLENS_OAUTH_PUBLIC_URL: resource,
    MODLENS_OAUTH_ISSUER: issuer, MODLENS_OAUTH_CLIENT_ID: 'test-modlens', MODLENS_OAUTH_SCOPES: 'partner.read offline_access',
    MODLENS_OAUTH_PROFILE_URL: issuer + '/profile', MODLENS_OAUTH_REQUIRED_FIELD: 'is_partner',
    MODLENS_OAUTH_REQUIRED_VALUE: 'true', MODLENS_OAUTH_STORAGE_KEY: randomBytes(32).toString('base64') };
let server;
let serverOutput = '';
async function start() {
    server = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    serverOutput = '';
    server.stderr.on('data', chunk => { serverOutput += chunk; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ModLens startup timed out: ${serverOutput}`)), 20000);
        const ready = () => { if (serverOutput.includes('listening on')) { clearTimeout(timer); server.stderr.off('data', ready); resolve(); } };
        server.stderr.on('data', ready);
        server.once('error', reject);
        server.once('exit', () => { clearTimeout(timer); reject(new Error(`ModLens exited: ${serverOutput}`)); });
        ready();
    });
}
async function stop() {
    if (!server || server.exitCode !== null) return;
    const exited = once(server, 'exit');
    server.kill();
    await exited;
}
const fetchManual = (url, init) => fetch(url, { ...init, redirect: 'manual' });
const form = data => new URLSearchParams(data);
const initialize = (access, extra = {}) => fetchManual(resource, { method: 'POST', headers: {
    Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra,
}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1' },
} }) });
let clientId;
async function login() {
    const verifier = randomBytes(32).toString('base64url');
    const pkce = createHash('sha256').update(verifier).digest('base64url');
    const callback = 'http://127.0.0.1:54321/callback';
    const auth = new URL(`http://127.0.0.1:${mcpPort}/oauth/authorize`);
    for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: callback, response_type: 'code',
        code_challenge: pkce, code_challenge_method: 'S256', state: 'client-state', resource, scope: 'modlens' }))
        auth.searchParams.set(key, value);
    const upstream = await fetchManual(auth);
    assert.equal(upstream.status, 302);
    const back = await fetchManual(upstream.headers.get('location'));
    assert.equal(back.status, 302);
    const done = await fetchManual(back.headers.get('location'));
    assert.equal(done.status, 200);
    assert.match(done.headers.get('content-security-policy'), /default-src 'none'/);
    const consentPage = await done.text();
    assert.match(consentPage, /CREEPERHOST/);
    assert.match(consentPage, /Allow access\?/);
    assert.match(consentPage, /Only continue if you started this request/);
    const approval = consentPage.match(/name="approval" value="([^"]+)"/)?.[1];
    assert.ok(approval);
    const approved = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/approve`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ approval, decision: 'allow' }) });
    assert.equal(approved.status, 302);
    const duplicateApproval = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/approve`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ approval, decision: 'allow' }) });
    assert.equal(duplicateApproval.status, 302);
    assert.equal(duplicateApproval.headers.get('location'), approved.headers.get('location'),
        'a retried consent submission receives the original authorization redirect');
    const changedDecision = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/approve`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ approval, decision: 'deny' }) });
    assert.equal(changedDecision.status, 400);
    assert.match(changedDecision.headers.get('content-type'), /text\/html/);
    assert.match(await changedDecision.text(), /Expired or reused consent request/);
    const result = new URL(approved.headers.get('location'));
    assert.equal(result.searchParams.get('state'), 'client-state');
    assert.equal(result.searchParams.get('iss'), `http://127.0.0.1:${mcpPort}`);
    const tokenBody = form({ grant_type: 'authorization_code', client_id: clientId,
        code: result.searchParams.get('code'), redirect_uri: callback, code_verifier: verifier, resource });
    const exchanged = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tokenBody });
    assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json();
    const replay = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tokenBody });
    assert.equal(replay.status, 400, 'authorization code cannot be replayed');
    assert.deepEqual(await replay.json(), { error: 'invalid_grant', error_description: 'Expired or reused authorization code' });
    assert.match(serverOutput, /"event":"consent_submission_retried"/);
    assert.match(serverOutput, /"event":"token_issued"/);
    assert.match(serverOutput, /"event":"request_failed".*"route":"\/oauth\/token"/);
    for (const secret of [approval, result.searchParams.get('code'), verifier, tokens.access_token, tokens.refresh_token])
        assert.ok(!serverOutput.includes(secret), 'OAuth logs must not contain credentials or bearer material');
    return tokens;
}
try {
    await start();
    assert.match(serverOutput, /"event":"provider_metadata_retry".*"status":503/,
        'transient provider discovery failures are logged and retried');
    assert.match(serverOutput, /"event":"provider_metadata_response".*temporarily_unavailable/,
        'failed provider responses include a useful body excerpt');
    assert.ok(!serverOutput.includes('metadata-secret'), 'provider response logging redacts token fields');
    const absent = await fetchManual(resource);
    assert.equal(absent.status, 401);
    assert.match(absent.headers.get('www-authenticate'), /resource_metadata=/);
    const metadata = await (await fetchManual(`http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.deepEqual(metadata.authorization_servers, [`http://127.0.0.1:${mcpPort}`]);
    const registration = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/register`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:54321/callback'] }) });
    assert.equal(registration.status, 201);
    clientId = (await registration.json()).client_id;
    const tokens = await login();
    assert.match(tokens.access_token, /^mla_/);
    assert.match(tokens.refresh_token, /^mlr_/);
    assert.equal((await initialize(tokens.access_token)).status, 200);
    assert.equal((await initialize(tokens.access_token, { 'x-modlens-user-id': 'forged' })).status, 401);
    await stop();
    await start();
    assert.equal((await initialize(tokens.access_token)).status, 200, 'grant survives restart');
    const refresh = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token',
            client_id: clientId, refresh_token: tokens.refresh_token, resource }) });
    assert.equal(refresh.status, 200);
    const rotated = await refresh.json();
    const replay = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token',
            client_id: clientId, refresh_token: tokens.refresh_token }) });
    assert.equal(replay.status, 400);
    const firstSession = await initialize(rotated.access_token);
    assert.equal(firstSession.status, 200);
    const sessionId = firstSession.headers.get('mcp-session-id');
    assert.ok(sessionId);
    subject = 'customer:99';
    const otherAccount = await login();
    assert.equal((await initialize(otherAccount.access_token, { 'mcp-session-id': sessionId })).status, 404,
        'one account cannot reuse another account session');
    profiles.delete(`upstream-${serial}`);
    assert.equal((await initialize(otherAccount.access_token)).status, 401, 'revoked upstream access fails closed');
    partner = false;
    assert.equal((await initialize(rotated.access_token)).status, 403);
    assert.equal((await initialize(rotated.access_token)).status, 401);
    const denied = await fetchManual(`http://127.0.0.1:${mcpPort}/oauth/authorize?client_id=bad`);
    assert.equal(denied.status, 400);
    await stop();
    delete env.MODLENS_OAUTH_REQUIRED_FIELD;
    delete env.MODLENS_OAUTH_REQUIRED_VALUE;
    await start();
    const generalAccount = await login();
    assert.equal((await initialize(generalAccount.access_token)).status, 200,
        'self-hosted mode accepts a valid account without a claim rule');
    console.log('Hosted OAuth discovery, registration, sign-in, persistence, refresh, replay, session, revocation, partner, gateway-header and self-hosted checks passed.');
} finally {
    await stop();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
}
