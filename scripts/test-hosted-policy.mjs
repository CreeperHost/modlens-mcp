// Real transports, synthetic source only: no Minecraft download or decompilation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";

const root = await mkdtemp(join(tmpdir(), "modlens-hosted-test-"));
const entry = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
const secret = randomBytes(32).toString("hex");
const env = { ...process.env, MCP_PORT: String(port), MCP_HOST: "127.0.0.1", MODLENS_HOME: root,
    MODLENS_CACHE_ROOT: join(root, "cache"), DATABASE_URL: `file:${join(root, "usage.db")}`,
    MODLENS_HOSTED_LIMITS: "1", MODLENS_HOSTED_PROXY_SECRET: secret, MODLENS_HOSTED_SOURCE_LINES: "200",
    MODLENS_HOSTED_MC_SOURCE: "1", MODLENS_HOSTED_MC_SOURCE_TEAMS: "partner",
    MODLENS_HOSTED_DAILY_BYTES: "15000", MODLENS_HOSTED_PERIOD_BYTES: "100000",
    MODLENS_HOSTED_DAILY_REQUESTS: "1000", MODLENS_HOSTED_MINUTE_REQUESTS: "120",
    MODLENS_HOSTED_RESPONSE_BYTES: "131072", MODLENS_AUTO_EMBED: "0", MODLENS_AUTO_GRAPH: "0" };
const source = Array.from({ length: 600 }, (_, i) => `// Synthetic fixture line ${i + 1}`).join("\n");
const fixtureDir = join(env.MODLENS_CACHE_ROOT, "mc-decompiled-named", "1.21.1", "example");
await mkdir(fixtureDir, { recursive: true });
await writeFile(join(fixtureDir, "Fixture.java"), source);
await writeFile(join(env.MODLENS_CACHE_ROOT, "mc-decompiled-named", "1.21.1", ".decompile.done"), "0");
const headers = (user, team) => ({ "x-modlens-proxy-secret": secret, "x-modlens-user-id": user,
    ...(team ? { "x-modlens-team-id": team } : {}) });
let server, exited;
const clients = [];
async function start() {
    let logs = "";
    server = spawn(process.execPath, [entry], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    exited = once(server, "exit");
    server.stderr.on("data", data => { logs += data; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timed out: ${logs}`)), 15000);
        const ready = () => {
            if (logs.includes("listening on")) { clearTimeout(timer); server.stderr.off("data", ready); resolve(); }
        };
        server.stderr.on("data", ready);
        server.once("error", reject);
        server.once("exit", () => { clearTimeout(timer); reject(new Error(`Server exited: ${logs}`)); });
        ready();
    });
}
async function connect(user, team) {
    const client = new Client({ name: "hosted-policy-test", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: headers(user, team) } });
    await client.connect(transport);
    return { client, transport };
}
const read = (client, startLine = 1) => client.callTool({ name: "mc_source", arguments: {
    action: "get_source", version: "1.21.1", className: "example.Fixture", startLine, maxLines: 10000,
} });
let passed = false;
try {
    await start();
    const unauthorized = await fetch(endpoint, { method: "POST", headers: { "x-modlens-user-id": "spoof" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const publicUser = await connect("public-developer");
    const publicTools = await publicUser.client.listTools();
    const publicMc = publicTools.tools.find(t => t.name === "mc_source");
    assert.ok(publicMc.inputSchema.properties.action.enum.includes("source_info"));
    assert.ok(publicMc.inputSchema.properties.action.enum.includes("get_source"));
    assert.ok(!publicMc.inputSchema.properties.action.enum.includes("bytecode"));
    const info = await publicUser.client.callTool({ name: "mc_source", arguments: {
        action: "source_info", version: "1.21.1", className: "example.Fixture",
    } });
    assert.deepEqual(JSON.parse(info.content[0].text), { version: "1.21.1", className: "example/Fixture", cached: true, totalLines: 600 });
    const missingInfo = await publicUser.client.callTool({ name: "mc_source", arguments: {
        action: "source_info", version: "1.21.1", className: "example.Missing",
    } });
    assert.deepEqual(JSON.parse(missingInfo.content[0].text), { version: "1.21.1", className: "example/Missing", cached: false, totalLines: null });
    // Seed synthetic version metadata so preparation can index the cached fixture offline.
    const fixtureDb = new Database(join(root, "usage.db"));
    fixtureDb.prepare("INSERT INTO mc_versions (version_id, type, release_time) VALUES (?, ?, ?)")
        .run("1.21.1", "release", Date.now());
    fixtureDb.close();
    const publicSearch = await publicUser.client.callTool({ name: "mc_source", arguments: {
        action: "search_code", version: "1.21.1", query: "Synthetic fixture line 319",
    } });
    assert.ok(!publicSearch.isError, JSON.stringify(publicSearch));
    assert.deepEqual(JSON.parse(publicSearch.content[0].text), [{ file: "example/Fixture.java", line: 319 }]);
    const publicSource = await read(publicUser.client);
    assert.ok(!publicSource.isError, JSON.stringify(publicSource));
    assert.ok(!JSON.stringify(publicSource).includes("Synthetic fixture"));
    assert.equal(JSON.parse(publicSource.content[0].text).status, "preparing");
    let prepared;
    for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        prepared = JSON.parse((await read(publicUser.client)).content[0].text);
        if (prepared.status === "ready") break;
    }
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    assert.equal(prepared.indexed, true);
    const indexedSearch = await publicUser.client.callTool({ name: "mc_source", arguments: {
        action: "search_indexed", version: "1.21.1", query: "fixture",
    } });
    assert.ok(!indexedSearch.isError, JSON.stringify(indexedSearch));
    assert.deepEqual(JSON.parse(indexedSearch.content[0].text), [{ className: "example/Fixture" }]);
    const { client, transport } = await connect("developer-a", "partner");
    const listed = await client.listTools();
    assert.ok(listed.tools.some(t => t.name === "report_issue"), "Hosted users must discover issue reporting");
    const reporter = await connect("issue-reporter");
    const preparedIssue = await reporter.client.callTool({ name: "report_issue", arguments: {
        action: "prepare", title: "Hosted test fixture", summary: "Synthetic report; never submit.",
    } });
    assert.ok(!preparedIssue.isError, JSON.stringify(preparedIssue));
    const issuePlan = JSON.parse(preparedIssue.content[0].text);
    assert.equal(issuePlan.state, "draft_prepared");
    assert.equal(issuePlan.executed, false);
    assert.equal(issuePlan.repository.url, "https://github.com/CreeperHost/modlens-mcp");
    const mc = listed.tools.find(t => t.name === "mc_source");
    assert.ok(mc.inputSchema.properties.action.enum.includes("bytecode"));
    for (const action of ["decompile", "get_paths", "index", "decompile_status"]) {
        assert.ok(!mc.inputSchema.properties.action.enum.includes(action), action);
    }
    assert.ok(listed.tools.some(t => t.name === "mc_data"));
    assert.ok(listed.tools.find(t => t.name === "mod_bytecode").inputSchema.properties.startLine);
    const denied = await client.callTool({ name: "mc_source", arguments: { action: "get_paths", version: "1.21.1" } });
    assert.ok(denied.isError);
    const wrongOwner = await fetch(endpoint, { headers: { ...headers("developer-b"), "mcp-session-id": transport.sessionId, accept: "text/event-stream" } });
    assert.equal(wrongOwner.status, 404);
    const wrongTeam = await fetch(endpoint, { headers: { ...headers("developer-a"), "mcp-session-id": transport.sessionId, accept: "text/event-stream" } });
    assert.equal(wrongTeam.status, 404);
    const first = await read(client);
    assert.ok(!first.isError, JSON.stringify(first));
    assert.equal(first.content[0].text, source.split("\n").slice(0, 200).join("\n"));
    const second = await read(client, 201);
    assert.ok(!second.isError, JSON.stringify(second));
    assert.equal(second.content[0].text, source.split("\n").slice(200, 400).join("\n"));
    const exhausted = await read(client, 401);
    assert.ok(exhausted.isError);
    assert.ok(!JSON.stringify(exhausted).includes("Synthetic fixture"));
    const reconnected = await connect("developer-a", "partner");
    assert.ok((await read(reconnected.client)).isError, "reconnect must retain quota");
    for (const c of clients.splice(0)) await c.close();
    server.kill(); await exited;
    await start();
    const restarted = await connect("developer-a", "partner");
    assert.ok((await read(restarted.client)).isError, "restart must retain quota");
    const different = await connect("developer-b", "partner");
    assert.ok(!(await read(different.client)).isError, "separate verified accounts have separate allowances");
    const local = new Client({ name: "hosted-local-test", version: "1" });
    clients.push(local);
    await local.connect(new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root,
        env: { ...env, MCP_PORT: "" }, stderr: "pipe" }));
    const localResult = await read(local);
    assert.ok(!localResult.isError, JSON.stringify(localResult));
    assert.equal(localResult.content[0].text, source, "local source access remains unrestricted");
    passed = true;
    console.log("PASS: public metadata-only access, team source access, authentication, account/session binding, source paging, cumulative limits, reconnect/restart persistence and unrestricted local access");
} finally {
    for (const client of clients) await client.close().catch(() => {});
    if (server && server.exitCode === null) { server.kill(); await exited; }
    if (passed) await rm(root, { recursive: true, force: true });
    else console.error(`Fixture retained for debugging: ${root}`);
}
