import { mkdir, readFile, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CACHE_ROOT } from "../cache.js";
import { RUNTIME_HELP } from "./hub.js";
import { runtimeRequest } from "./requests.js";
import {
    companionDescriptor,
    descriptorPath,
    startCompanion,
    type CompanionDescriptor,
} from "./companion.js";

const root = join(CACHE_ROOT, "runtime");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function descriptor(): Promise<CompanionDescriptor | undefined> {
    try {
        return companionDescriptor.parse(JSON.parse(await readFile(descriptorPath(root), "utf8")));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
    }
}
async function call(connection: CompanionDescriptor, request: unknown, timeout = 35000): Promise<unknown> {
    const response = await fetch(connection.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeout),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Companion HTTP ${response.status}`);
    return result;
}
async function available(): Promise<CompanionDescriptor | undefined> {
    const saved = await descriptor();
    if (!saved) return;
    try {
        const health = (await call(saved, { action: "ping" }, 1000)) as { protocol: number; pid: number };
        if (health.protocol !== 1 || health.pid !== saved.pid) throw new Error("Companion identity mismatch");
        return saved;
    } catch {
        return;
    }
}
async function ensureCompanion() {
    const running = await available();
    if (running) return running;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const logPath = join(root, "companion.log"),
        log = await open(logPath, "w", 0o600);
    let child;
    try {
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--serve"], {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", log.fd, log.fd],
            env: process.env,
        });
        await new Promise<void>((resolve, reject) => {
            child!.once("spawn", resolve);
            child!.once("error", reject);
        });
        child.unref();
    } finally {
        await log.close();
    }
    const until = Date.now() + 15000;
    while (Date.now() < until) {
        const connected = await available();
        if (connected) return connected;
        // Another simultaneous CLI may have won the bridge lock. Give that
        // process time to publish its descriptor even if our child has exited.
        await sleep(150);
    }
    const logText = await readFile(logPath, "utf8").catch(() => "");
    throw new Error(`Local companion did not start. ${logText.slice(-3000)} See ${logPath}`);
}

export async function runtimeCli(args: string[]): Promise<number> {
    try {
        if (!args.length || args[0] === "help" || args[0] === "--help") {
            console.log(
                JSON.stringify({
                    ...RUNTIME_HELP,
                    usage: [
                        "modlens-mcp --runtime --request-file <UTF-8 JSON file>",
                        "modlens-mcp --runtime status|sessions|start|stop",
                    ],
                    requestExample: {
                        action: "setup",
                        projectDir: "<absolute mod project directory>",
                        mode: "observe",
                        mcVersion: "26.3",
                    },
                }),
            );
            return 0;
        }
        if (args[0] === "stop" && args.length === 1) {
            const running = await available();
            if (!running) {
                console.log(JSON.stringify({ state: "not_running" }));
                return 0;
            }
            const result = await call(running, { action: "stop_helper" });
            const until = Date.now() + 5000;
            while (Date.now() < until) {
                const owner = await readFile(join(root, "bridge.lock"), "utf8").then(
                    (text) => JSON.parse(text),
                    () => undefined,
                );
                if (owner?.pid !== running.pid) {
                    console.log(JSON.stringify(result));
                    return 0;
                }
                await sleep(50);
            }
            throw new Error("Companion shutdown is still in progress; wait before restarting it.");
        }
        let request: unknown;
        if (args[0] === "--request-file" && args.length === 2) {
            if ((await stat(args[1])).size > 64 * 1024)
                throw new Error("Runtime request file exceeds 64 KiB");
            request = JSON.parse((await readFile(args[1], "utf8")).replace(/^\uFEFF/, ""));
        } else if (args.length === 1 && ["status", "sessions", "start"].includes(args[0]))
            request = { action: args[0] === "start" ? "status" : args[0] };
        else
            throw new Error(
                "Use --runtime --request-file <file>, or --runtime help|status|sessions|start|stop",
            );
        const validated = runtimeRequest.parse(request);
        const connection = await ensureCompanion();
        // Exactly one submission. A broken response cannot safely imply non-execution.
        let result;
        try {
            result = await call(connection, validated);
        } catch (e) {
            throw new Error(
                `${String(e)}. Do not automatically replay a game action after uncertain delivery; inspect sessions/status first.`,
            );
        }
        console.log(JSON.stringify(result));
        return 0;
    } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        return 1;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--serve") {
    // This entry point is launched explicitly by the local CLI, never by remote MCP.
    delete process.env.MCP_PORT;
    try {
        const companion = await startCompanion(root);
        const close = () => {
            void companion.close().catch(console.error);
        };
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
    } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
    }
}
