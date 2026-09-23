import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startCompanion, companionDescriptor, descriptorPath } from "./companion.js";
import { runtimeAction, runtimeHub } from "../tools/runtime.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "modlens-companion-test-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const jar = join(root, "agent.jar");
    await writeFile(jar, "fixture");
    const companion = await startCompanion(join(root, "bridge"), jar);
    cleanup.push(companion.close);
    const request = (body: unknown, token = companion.descriptor.token, headers = {}) =>
        fetch(companion.descriptor.endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
        });
    const project = join(root, "project with spaces");
    await mkdir(join(project, "gradle/wrapper"), { recursive: true });
    await writeFile(join(project, "gradle/wrapper/gradle-wrapper.jar"), "fixture");
    return { root, companion, request, project };
}
describe("local companion for remote MCP", () => {
    it("requires local credentials and validates requests", async () => {
        const { request } = await fixture();
        expect((await request({ action: "status" }, "wrong")).status).toBe(403);
        expect((await request({ action: "status" }, "é".repeat(64))).status).toBe(403);
        expect(
            (await request({ action: "status" }, undefined, { Origin: "https://example.com" })).status,
        ).toBe(403);
        expect((await request({ action: "arbitrary_shell", command: "echo test" })).status).toBe(400);
        expect(await (await request({ action: "status" })).json()).toMatchObject({ enabled: false });
    });
    it("configures locally and returns image paths without base64", async () => {
        const { root, request, project, companion } = await fixture();
        const setup = (await (
            await request({ action: "setup", projectDir: project, mode: "hidden" })
        ).json()) as { projectId: string };
        expect(setup.projectId).toBeTruthy();
        const config = await readFile(join(project, ".modlens/runtime/connection.properties"), "utf8");
        const endpoint = /^endpoint=(.*)$/m.exec(config)![1].replace(/\\:/g, ":");
        const token = /^token=(.*)$/m.exec(config)![1];
        const sessionId = randomUUID();
        const packet = {
            protocol: 1,
            sessionId,
            pid: 123,
            startedAt: Date.now(),
            javaVersion: "25",
            capabilities: {},
            state: { mode: "hidden" },
            metrics: {},
            events: [],
            results: [],
        };
        expect(
            (
                await fetch(endpoint, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}` },
                    body: JSON.stringify(packet),
                })
            ).status,
        ).toBe(200);
        expect(await (await request({ action: "sessions" })).json()).toMatchObject([{ sessionId }]);
        const sessionDir = join(project, ".modlens/runtime/sessions", sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, "frame.png"), "image bytes");
        const image = await (
            await request({ action: "artifact", sessionId, artifactName: "frame.png" })
        ).json();
        expect(image).toMatchObject({ path: join(sessionDir, "frame.png"), mimeType: "image/png" });
        expect(image).not.toHaveProperty("data");
        const journal = await companion.hub.events();
        const waiting = companion.hub.events(journal.nextCursor, 30000);
        await companion.close();
        await waiting;
        await expect(access(descriptorPath(join(root, "bridge")))).rejects.toThrow();
    });
    it("remote MCP gives a local plan without executing or leaking host state", async () => {
        const setup = vi.spyOn(runtimeHub, "setup");
        const status = vi.spyOn(runtimeHub, "status");
        const prior = process.env.MCP_PORT;
        process.env.MCP_PORT = "8080";
        try {
            const request = {
                action: "setup" as const,
                projectDir: "C:/Users/Developer/My Mod",
                mode: "observe" as const,
            };
            const plan = await runtimeAction(request);
            expect(plan).toMatchObject({ executed: false, execution: "local_helper_required", request });
            expect(JSON.stringify(plan)).toContain("--request-file");
            expect(await runtimeAction({ action: "status" })).toMatchObject({ executed: false });
            expect(setup).not.toHaveBeenCalled();
            expect(status).not.toHaveBeenCalled();
        } finally {
            if (prior === undefined) delete process.env.MCP_PORT;
            else process.env.MCP_PORT = prior;
        }
    });
    it("never follows a companion descriptor to a remote host", () => {
        for (const endpoint of [
            "https://example.com/runtime",
            "http://localhost:1234/runtime",
            "http://127.0.0.1:1234/other",
        ])
            expect(() =>
                companionDescriptor.parse({ protocol: 1, pid: 123, token: "a".repeat(64), endpoint }),
            ).toThrow();
    });
});
