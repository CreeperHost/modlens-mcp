// Exercise the packed CLI as an npx consumer, outside the source checkout.
// Run after `npm run build`, or pass a tarball / release-artifact directory.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "modlens-package-test-"));
const consumer = join(root, "consumer");
mkdirSync(consumer);
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "package-smoke-consumer", private: true }));
writeFileSync(join(root, "npmrc"), "");
const npm = process.env.npm_execpath ?? (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
    : realpathSync(join(dirname(process.execPath), "npm")));
assert.ok(existsSync(npm), "Run this test via npm run test:package");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(DATABASE_URL|MODLENS_.*|MCP_PORT|DEBUG|NODE_OPTIONS|NODE_PATH|PATH)$/i.test(key)));
Object.assign(env, {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
    npm_config_cache: join(root, "cache"),
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    MODLENS_AUTO_EMBED: "0",
    MODLENS_CACHE_ROOT: join(root, "modlens-cache"),
});

function start(args, home) {
    const child = spawn(process.execPath, [npm, ...args], {
        cwd: consumer, env: { ...env, MODLENS_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const done = new Promise((resolveDone, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolveDone({ code, signal }));
    });
    return { child, done, output: () => output };
}

async function stop(run) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) return;
    if (process.platform === "win32") {
        // Only terminate the process tree created by this test.
        try { execFileSync("taskkill.exe", ["/pid", String(run.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    } else {
        try { process.kill(-run.child.pid, "SIGTERM"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    }
    await deadline(run.done, 10_000, "test process shutdown");
}

async function deadline(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
        })]);
    } finally { clearTimeout(timer); }
}

let passed = false;
try {
    let tarball;
    if (process.argv[2]) {
        tarball = resolve(process.argv[2]);
        if (statSync(tarball).isDirectory()) {
            const files = readdirSync(tarball).filter(file => file.endsWith(".tgz"));
            assert.equal(files.length, 1, "Expected one package tarball");
            tarball = join(tarball, files[0]);
        }
    } else {
        const pack = JSON.parse(execFileSync(process.execPath, [npm, "pack", "--json", "--pack-destination", root], {
            env, encoding: "utf8", timeout: 60_000,
        }));
        tarball = join(root, pack[0].filename);
    }
    console.log(`Testing ${tarball} on ${process.version} (${process.platform}/${process.arch})`);
    const args = ["exec", "--yes", "--foreground-scripts", "--package", tarball, "--", "modlens-mcp"];

    const setup = start([...args, "--setup"], join(root, "setup-home"));
    try {
        await deadline(new Promise((resolvePrompt, reject) => {
            const inspect = () => {
                if (setup.output().includes("Choose a setup profile")) resolvePrompt();
            };
            setup.child.stdout.on("data", inspect);
            setup.child.stderr.on("data", inspect);
            setup.done.then(result => reject(new Error(`Setup exited before prompting: ${JSON.stringify(result)}\n${setup.output()}`)), reject);
        }), 180_000, "fresh npx install and setup prompt");
        setup.child.stdin.write("\x03"); // Cancel the wizard before saving configuration.
        assert.equal((await deadline(setup.done, 15_000, "setup cancellation")).code, 0, setup.output());
        console.log("PASS: fresh npx install and interactive setup prompt");
    } catch (error) {
        writeFileSync(join(root, "setup.log"), setup.output());
        throw error;
    } finally { await stop(setup); }

    const installs = readdirSync(join(root, "cache/_npx"))
        .map(dir => join(root, "cache/_npx", dir, "node_modules/@creeperhost/modlens-mcp"))
        .filter(dir => existsSync(join(dir, "package.json")));
    assert.equal(installs.length, 1);
    const installed = installs[0];
    const initScript = execFileSync(process.execPath, [join(installed, "dist/launcher.js"), "--gradle-init-script"], { env, encoding: "utf8" }).trim();
    assert.equal(initScript, join(installed, "scripts/gradle/modlens.init.gradle"));
    assert.ok(statSync(initScript).size > 0, "Gradle exporter must ship in the npm package");
    assert.ok(statSync(join(installed, "scripts/project-upload.mjs")).size > 0, "Remote uploader must ship in the npm package");
    const keyFile = join(root, "project-key.txt");
    writeFileSync(keyFile, "a".repeat(64));
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, [join(installed, "dist/launcher.js"), "--project", "list", `--key-file=${keyFile}`], { env, encoding: "utf8" })), []);
    const require = createRequire(join(installed, "package.json"));
    const adapterRequire = createRequire(require.resolve("@prisma/adapter-better-sqlite3"));
    assert.equal(require.resolve("better-sqlite3"), adapterRequire.resolve("better-sqlite3"), "Prisma must share the v12 driver");
    assert.match(require("better-sqlite3/package.json").version, /^12\./);

    const dataHome = join(root, "server-home");
    async function checkServer() {
        const run = start(args, dataHome);
        const pending = new Map();
        let buffer = "";
        let id = 0;
        run.child.stdout.on("data", data => {
            buffer += data;
            while (buffer.includes("\n")) {
                const newline = buffer.indexOf("\n");
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line) continue;
                try {
                    const message = JSON.parse(line);
                    const waiter = pending.get(message.id);
                    if (waiter) {
                        pending.delete(message.id);
                        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
                        else waiter.resolve(message.result);
                    }
                } catch (error) { for (const waiter of pending.values()) waiter.reject(error); }
            }
        });
        run.done.then(result => {
            for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited: ${JSON.stringify(result)}\n${run.output()}`));
        });
        function send(message) { run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
        function request(method, params) {
            return deadline(new Promise((resolveRequest, reject) => {
                const requestId = ++id;
                pending.set(requestId, { resolve: resolveRequest, reject });
                send({ id: requestId, method, params });
            }), 30_000, method);
        }
        try {
            const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "package-smoke", version: "1.0.0" } });
            assert.ok(initialized.serverInfo);
            send({ method: "notifications/initialized" });
            const list = await request("tools/list", {});
            assert.ok(list.tools.some(tool => tool.name === "mod"));
            assert.ok(list.tools.some(tool => tool.name === "project"));
            const stats = await request("tools/call", { name: "mod", arguments: { action: "stats" } });
            assert.ok(!stats.isError, JSON.stringify(stats));
            assert.equal(JSON.parse(stats.content.find(item => item.type === "text").text).total, 0);
            return run.output();
        } finally { await stop(run); }
    }

    const first = await checkServer();
    assert.match(first, /First run/);
    const database = join(dataHome, "data/modlens.db");
    assert.ok(statSync(database).size > 0);
    console.log("PASS: first-run SQLite bootstrap, MCP handshake, tools/list, database stats");

    // Check the actual installed client/adapter with dates, BLOBs, and transactions.
    // Use a child so Windows releases the native .node file before cleanup.
    function checkDatabase(mode) {
        execFileSync(process.execPath, ["--input-type=module", "-e", `
            import assert from 'node:assert/strict';
            const { getDb, disconnect } = await import(process.argv[1]);
            const db = await getDb();
            try {
                const bytes = new Uint8Array([0, 1, 127, 128, 255]);
                if (process.argv[2] === 'create') {
                    const doc = await db.docEntry.create({ data: { title: 'Package smoke', url: 'https://example.invalid', embedding: bytes } });
                    assert.deepEqual(doc.embedding, bytes);
                    assert.ok(doc.createdAt instanceof Date);
                    await db.$transaction(async tx => { await tx.docEntry.update({ where: { id: doc.id }, data: { summary: 'committed' } }); });
                    await assert.rejects(db.$transaction(async tx => {
                        await tx.docEntry.update({ where: { id: doc.id }, data: { summary: 'rolled back' } });
                        throw new Error('rollback sentinel');
                    }), /rollback sentinel/);
                }
                const saved = await db.docEntry.findFirstOrThrow({ where: { title: 'Package smoke' } });
                assert.equal(saved.summary, 'committed');
                assert.deepEqual(saved.embedding, bytes);
            } finally { await disconnect(); }
        `, pathToFileURL(join(installed, "dist/db.js")).href, mode], {
            cwd: consumer, env: { ...env, DATABASE_URL: `file:${database}` }, timeout: 30_000, stdio: "pipe",
        });
    }
    checkDatabase("create");
    console.log("PASS: installed Prisma client/adapter CRUD, binary data, dates, commit and rollback");

    const second = await checkServer();
    assert.doesNotMatch(second, /First run/);
    checkDatabase("read");
    console.log("PASS: second npx run preserves existing database contents");
    passed = true;
} finally {
    if (passed) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    else console.error(`Package test artifacts retained at ${root}`);
}
