// HTTP MCP -> local CLI -> persistent companion -> real instrumented SDL JVM.
// Set JAVA_HOME (25+) and MODLENS_SDL_CLASSPATH, after building server and agent.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (!process.env.JAVA_HOME || !process.env.MODLENS_SDL_CLASSPATH)
    throw new Error("Set JAVA_HOME and MODLENS_SDL_CLASSPATH");
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "modlens-runtime-remote-"));
console.log("Evidence: " + root);
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const remoteEnv = {
    ...process.env,
    MCP_PORT: String(port),
    MCP_HOST: "127.0.0.1",
    MODLENS_AUTO_EMBED: "0",
    MODLENS_CACHE_ROOT: join(root, "remote-cache"),
    MODLENS_HOME: join(root, "remote-home"),
    DATABASE_URL: `file:${join(root, "unused.db")}`,
};
const localEnv = {
    ...process.env,
    MCP_PORT: String(port),
    MODLENS_CACHE_ROOT: join(root, "local-cache"),
    MODLENS_HOME: join(root, "local-home"),
};
const server = spawn(process.execPath, [join(repo, "dist/server.js")], {
    cwd: root,
    env: remoteEnv,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
});
let serverLog = "";
server.stderr.on("data", (b) => (serverLog += b));
const serverDone = once(server, "exit");
const client = new Client({ name: "runtime-remote-smoke", version: "1.0.0" });
const cli = (args) =>
    JSON.parse(
        execFileSync(process.execPath, [join(repo, "dist/launcher.js"), "--runtime", ...args], {
            cwd: root,
            env: localEnv,
            encoding: "utf8",
            timeout: 45000,
        }),
    );
async function local(request) {
    const file = join(root, "request.json");
    await writeFile(file, JSON.stringify(request));
    return cli(["--request-file", file]);
}
async function plan(request) {
    const response = await client.callTool({ name: "runtime", arguments: request });
    assert.ok(!response.isError, JSON.stringify(response));
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.executed, false);
    assert.equal(result.execution, "local_helper_required");
    assert.ok(result.invocation.arguments.includes("--runtime"));
    return result;
}
async function throughRemote(request) {
    return local((await plan(request)).request);
}
async function wait(fn, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Timed out\n" + serverLog);
}
let game,
    gameDone,
    gameLog = "";
try {
    await wait(() => serverLog.includes("listening on"));
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    assert.match(client.getInstructions(), /local.*helper/);
    const project = join(root, "local project with spaces");
    await mkdir(join(project, "gradle/wrapper"), { recursive: true });
    await writeFile(join(project, "gradle/wrapper/gradle-wrapper.jar"), "fixture");
    const setupPlan = await plan({ action: "setup", projectDir: project, mode: "hidden" });
    await assert.rejects(access(join(project, ".modlens")), "Remote planning must not change local files");
    const setup = await local(setupPlan.request);
    assert.equal(setup.state, "configured");
    await assert.rejects(
        access(join(root, "local-home", "data/modlens.db")),
        "Helper must not bootstrap a source database",
    );
    await assert.rejects(
        access(join(root, "remote-cache/runtime")),
        "Remote server must not start a runtime bridge",
    );
    const agent = join(repo, "dist/runtime/modlens-agent.jar");
    const java = (name) =>
        join(process.env.JAVA_HOME, "bin", name + (process.platform === "win32" ? ".exe" : ""));
    execFileSync(
        java("javac"),
        ["-cp", agent, "-d", root, join(repo, "runtime-agent/test/io/modlens/runtime/NativeSmoke.java")],
        { stdio: "inherit" },
    );
    game = spawn(
        java("java"),
        [
            "--enable-native-access=ALL-UNNAMED",
            setup.vmOption,
            "-cp",
            [root, agent, process.env.MODLENS_SDL_CLASSPATH].join(delimiter),
            "io.modlens.runtime.NativeSmoke",
            root,
        ],
        { windowsHide: true },
    );
    game.stdout.on("data", (b) => (gameLog += b));
    game.stderr.on("data", (b) => (gameLog += b));
    gameDone = once(game, "exit");
    const session = await wait(async () =>
        (await local({ action: "sessions" })).find((s) => s.capabilities.inputBackend === "lwjgl-sdl3"),
    );
    const key = await throughRemote({
        action: "command",
        sessionId: session.sessionId,
        command: { type: "key", key: "W", down: true, holdMs: 150 },
    });
    assert.equal(key.state, "event_delivered");
    const allocation = await throughRemote({
        action: "command",
        sessionId: session.sessionId,
        command: { type: "allocations", packagePrefix: "io.modlens.runtime.NativeSmoke" },
    });
    const report = await throughRemote({
        action: "artifact",
        sessionId: session.sessionId,
        artifactName: allocation.artifact,
    });
    assert.ok(JSON.parse(report.text).hotspots.some((h) => h.site.includes("allocateFixture")));
    assert.ok(
        cli(["sessions"]).some((s) => s.sessionId === session.sessionId),
        "CLI invocations must share the same live session",
    );
    cli(["stop"]);
    await local({ action: "status" });
    await wait(async () =>
        (await local({ action: "sessions" })).find((s) => s.sessionId === session.sessionId),
    );
    const threads = await throughRemote({
        action: "command",
        sessionId: session.sessionId,
        command: { type: "threads" },
    });
    assert.match(
        (
            await throughRemote({
                action: "artifact",
                sessionId: session.sessionId,
                artifactName: threads.artifact,
            })
        ).text,
        /ModLens telemetry/,
    );
    await writeFile(join(root, "finish"), "done");
    assert.equal((await gameDone)[0], 0, gameLog);
    const events = await wait(async () => {
        const result = await local({ action: "events" });
        return result.events.some((e) => e.type === "uncaught_exception") && result;
    });
    assert.match(gameLog, /KEY 26/);
    await writeFile(
        join(root, "evidence.json"),
        JSON.stringify({ session, report: JSON.parse(report.text), events, gameLog }, null, 2),
    );
    cli(["stop"]);
    await wait(async () => {
        try {
            await access(join(root, "local-cache/runtime/bridge.lock"));
            return false;
        } catch {
            return true;
        }
    });
    assert.equal(cli(["stop"]).state, "not_running");
    console.log(
        "PASS: remote MCP guidance, local helper setup, persistent session, real JVM input, allocation report, crash events, and clean stop",
    );
} finally {
    if (game && game.exitCode === null) {
        game.kill();
        await gameDone;
    }
    try {
        cli(["stop"]);
    } catch {}
    await client.close();
    server.kill();
    await serverDone;
    await writeFile(join(root, "server.log"), serverLog);
}
