import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeHub } from "./hub.js";
import { properties, runtimeCommand } from "./protocol.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "modlens-runtime-test-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project with spaces"),
        jar = join(root, "agent.jar");
    await mkdir(join(project, "gradle/wrapper"), { recursive: true });
    await writeFile(join(project, "gradle/wrapper/gradle-wrapper.jar"), "fixture");
    await writeFile(jar, "fixture jar");
    const hub = new RuntimeHub(join(root, "cache"), jar);
    cleanup.push(() => hub.close());
    return { root, project, hub };
}
function decodeProperties(text: string) {
    return Object.fromEntries(
        text
            .trim()
            .split("\n")
            .map((line) => {
                const i = line.indexOf("=");
                return [
                    line.slice(0, i),
                    line
                        .slice(i + 1)
                        .replace(/\\([ :=#!])/g, "$1")
                        .replace(/\\\\/g, "\\"),
                ];
            }),
    );
}
async function connect(hub: RuntimeHub, project: string) {
    const setup = await hub.setup(project, "hidden");
    const conf = decodeProperties(
        await readFile(join(project, ".modlens/runtime/connection.properties"), "utf8"),
    );
    const sessionId = randomUUID();
    const packet = {
        protocol: 1,
        sessionId,
        pid: 123,
        startedAt: Date.now(),
        javaVersion: "25",
        capabilities: {},
        state: {},
        metrics: {},
        events: [],
        results: [],
    };
    const send = (body: unknown = packet, token = conf.token, headers: Record<string, string> = {}) =>
        fetch(conf.endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
        });
    expect((await send()).status).toBe(200);
    return { setup, conf, packet, sessionId, send };
}
describe("optional runtime", () => {
    it("does nothing until setup and preserves existing project build files", async () => {
        const { hub, project } = await fixture();
        await writeFile(join(project, "build.gradle"), "// user build\n");
        expect(await hub.status()).toMatchObject({ enabled: false });
        expect(await hub.list()).toEqual([]);
        const a = await hub.setup(project, "hidden", ":client:runClient");
        const b = await hub.setup(project, "observe", ":client:runClient");
        expect(a.projectId).toBe(b.projectId);
        expect(a.vmOptions).toEqual([a.vmOption, "-XX:StackShadowPages=32"]);
        expect(await readFile(join(project, "build.gradle"), "utf8")).toBe("// user build\n");
        expect(await readFile(b.runConfiguration, "utf8")).toContain(":client:runClient");
        expect(JSON.stringify(await hub.status())).not.toContain('"token"');
    });
    it("rejects browser requests, wrong tokens, and malformed packets", async () => {
        const { hub, project } = await fixture();
        const { send } = await connect(hub, project);
        expect((await send(undefined, "wrong")).status).toBe(403);
        expect((await send(undefined, "é".repeat(64))).status).toBe(403);
        expect((await send({}, undefined, { Origin: "https://example.com" })).status).toBe(403);
        expect((await send({ protocol: 2 })).status).toBe(400);
    });
    it("delivers commands only once and waits for execution acknowledgments", async () => {
        const { hub, project } = await fixture();
        const { send, packet, sessionId } = await connect(hub, project);
        const result = hub.command(sessionId, { type: "key", key: "W", down: true, holdMs: 100 });
        await new Promise((r) => setTimeout(r, 5));
        const command = decodeProperties(await (await send()).text());
        expect(command.type).toBe("key");
        expect(await (await send()).text()).not.toContain("type=");
        await send({
            ...packet,
            results: [{ id: command.id, ok: true, data: { state: "event_delivered" } }],
        });
        expect(await result).toMatchObject({ state: "event_delivered" });
    });
    it("deduplicates replayed events and returns a usable cursor", async () => {
        const { hub, project } = await fixture();
        const { send, packet, sessionId } = await connect(hub, project);
        const initial = await hub.events();
        const waiting = hub.events(initial.nextCursor, 1000, sessionId);
        const update = {
            ...packet,
            events: [{ seq: 1, time: Date.now(), type: "minecraft_crash", data: { message: "test" } }],
        };
        await send(update);
        await send(update);
        expect((await waiting).events).toHaveLength(1);
        expect((await hub.events(initial.nextCursor)).events).toHaveLength(1);
    });
    it("rejects unmanaged run configurations and task injection", async () => {
        const { hub, project } = await fixture();
        await mkdir(join(project, ".run"));
        await writeFile(join(project, ".run/ModLens Client.run.xml"), "user file");
        await expect(hub.setup(project)).rejects.toThrow("non-ModLens");
        await expect(hub.setup(project, "hidden", "runClient; evil")).rejects.toThrow("Gradle task path");
    });
    it("escapes Java properties and bounds commands", () => {
        expect(properties({ text: "Hello\n世界😀", path: "C:\\with spaces" })).toContain(
            "\\u4e16\\u754c\\ud83d\\ude00",
        );
        expect(properties({ text: "a\nb=c" })).toBe("text=a\\nb\\=c\n");
        expect(() => runtimeCommand.parse({ type: "key", key: "W", down: true, holdMs: 100000 })).toThrow();
    });
    it("disables mutations on a remote HTTP MCP host", async () => {
        const { hub, project } = await fixture();
        const old = process.env.MCP_PORT;
        process.env.MCP_PORT = "8080";
        try {
            await expect(hub.setup(project)).rejects.toThrow("local stdio");
        } finally {
            if (old === undefined) delete process.env.MCP_PORT;
            else process.env.MCP_PORT = old;
        }
    });
    it("keeps one owner per cache and preserves history through bridge restart", async () => {
        const { hub, project, root } = await fixture();
        const { send, packet } = await connect(hub, project);
        await send({
            ...packet,
            events: [{ seq: 1, time: Date.now(), type: "uncaught_exception", data: { message: "retained" } }],
        });
        const other = new RuntimeHub(join(root, "cache"), join(root, "agent.jar"));
        cleanup.push(() => other.close());
        await expect(other.initialize()).rejects.toThrow("Another local");
        await hub.close();
        await other.initialize();
        expect((await other.events()).events.some((e) => e.type === "uncaught_exception")).toBe(true);
    });
    it("refuses symlinks in setup paths", async () => {
        const { hub, project, root } = await fixture();
        const outside = join(root, "outside");
        await mkdir(outside);
        await symlink(outside, join(project, ".modlens"), process.platform === "win32" ? "junction" : "dir");
        await expect(hub.setup(project)).rejects.toThrow("symlink");
    });
    it("confines artifacts to the connected session", async () => {
        const { hub, project, root } = await fixture();
        const { sessionId } = await connect(hub, project);
        await expect(hub.artifact(sessionId, "../escape.txt")).rejects.toThrow("Invalid artifact");
        const sessions = join(project, ".modlens/runtime/sessions", sessionId);
        await mkdir(sessions, { recursive: true });
        await writeFile(join(sessions, "threads.txt"), "diagnostic");
        expect(await hub.artifact(sessionId, "threads.txt")).toMatchObject({ text: "diagnostic" });
        const outside = join(root, "external");
        await mkdir(outside);
        await writeFile(join(outside, "escape.txt"), "outside");
        // A junction as the session directory must not widen the managed artifact root.
        await rm(sessions, { recursive: true });
        await symlink(outside, sessions, process.platform === "win32" ? "junction" : "dir");
        await expect(hub.artifact(sessionId, "escape.txt")).rejects.toThrow("symlink");
    });
});
