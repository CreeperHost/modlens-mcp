import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sqliteRawArgs } from "./sqlite-parameters.js";
import { boundHostedResult, hostedActions, hostedMinecraftSourceAccess, hostedMinecraftSourceTeams, HostedBudget, hostedLimits, hostedPrincipal, prepareHostedArgs, runHostedTool, type BudgetDatabase } from "./hosted-policy.js";

const limits = hostedLimits({});
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const json = (value: unknown) => text(JSON.stringify(value));
const lines = (count: number) => Array.from({ length: count }, (_, i) => `synthetic line ${i + 1}`).join("\n");
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks(); });

function sqlite(path = ":memory:"): BudgetDatabase {
    const db = new Database(path);
    cleanups.push(() => db.close());
    return {
        async $executeRawUnsafe(query, ...values) {
            const [sql, ...params] = sqliteRawArgs([query, ...values]);
            return db.prepare(sql as string).run(...params).changes;
        },
        async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
            const [sql, ...params] = sqliteRawArgs([query, ...values]);
            return db.prepare(sql as string).all(...params) as T;
        },
    };
}

describe("hosted identity and arguments", () => {
    it("ignores caller-selected identities without an authenticated gateway", () => {
        expect(hostedPrincipal({ authorization: "Bearer anything", "x-modlens-user-id": "new-account" })).toBe("shared");
    });
    it("requires gateway proof and derives a stable account bucket", () => {
        const headers = { "x-modlens-proxy-secret": "operator-secret", "x-modlens-user-id": "verified-account" };
        const subject = hostedPrincipal(headers, "operator-secret");
        expect(subject).toHaveLength(64);
        expect(hostedPrincipal({ ...headers, "mcp-session-id": "new-session" }, "operator-secret")).toBe(subject);
        expect(() => hostedPrincipal(headers, "incorrect-secret")).toThrow("Authenticated gateway");
        expect(() => hostedPrincipal({ ...headers, "x-modlens-user-id": ["a", "b"] }, "operator-secret")).toThrow();
    });
    it("validates configuration and clamps ranges without changing their start", () => {
        expect(limits.dailyBytes).toBe(5 * 1024 * 1024);
        expect(() => hostedLimits({ MODLENS_HOSTED_DAILY_BYTES: "NaN" })).toThrow();
        expect(prepareHostedArgs("mc_source", { action: "get_source", startLine: 401, maxLines: 5000, endLine: 9000 }, limits, true))
            .toMatchObject({ startLine: 401, maxLines: 200, endLine: 600 });
        for (const startLine of [-1, 0, 1.2, Infinity, Number.MAX_SAFE_INTEGER]) {
            expect(() => prepareHostedArgs("mc_source", { action: "get_source", startLine }, limits, true)).toThrow();
        }
    });
    it("blocks bulk, raw-file, export and unreviewed routes", () => {
        for (const [tool, action] of [["mc_source", "decompile"], ["mc_source", "get_paths"], ["mod", "embed_export"],
            ["mod", "graph_enrich_next"], ["mod_jar", "get_file"], ["mc_files", "raw"], ["future_tool", "get"]]) {
            expect(() => prepareHostedArgs(tool, { action }, limits)).toThrow();
        }
        expect(() => prepareHostedArgs("reports", { savePath: "/tmp/export" }, limits)).toThrow();
        expect(() => prepareHostedArgs("mod_jar", { action: "get_config", path: "Target.class" }, limits)).toThrow();
        expect(() => prepareHostedArgs("mc_files", { action: "list_files", branch: "source" }, limits)).toThrow();
    });
    it("preserves ordinary development actions and rejects empty extraction queries", () => {
        for (const [tool, action] of [["mc_source", "class_members"], ["mc_source", "source_info"], ["mc_data", "get_recipe"],
            ["mod_mixins", "targets"], ["project", "upload_chunk"], ["mc_files", "get_data"]]) {
            expect(prepareHostedArgs(tool, { action }, limits).action).toBe(action);
        }
        expect(() => prepareHostedArgs("mc_source", { action: "search_code", query: " " }, limits)).toThrow();
        expect(prepareHostedArgs("mc_source", { action: "search_code", query: "getBlock", limit: 10000 }, limits).limit).toBe(50);
    });
    it("requires gateway-assigned team membership for hosted Minecraft source", () => {
        const env = { MODLENS_HOSTED_MC_SOURCE: "1", MODLENS_HOSTED_MC_SOURCE_TEAMS: "trusted,partner" };
        expect(() => hostedMinecraftSourceTeams(env)).toThrow();
        const teams = hostedMinecraftSourceTeams(env, "x".repeat(32));
        expect(hostedMinecraftSourceAccess({ "x-modlens-team-id": "partner" }, teams)).toBe(true);
        expect(hostedMinecraftSourceAccess({ "x-modlens-team-id": "other" }, teams)).toBe(false);
        expect(hostedMinecraftSourceTeams({ MODLENS_HOSTED_MC_SOURCE: "0", MODLENS_HOSTED_MC_SOURCE_TEAMS: "partner" }, "x".repeat(32)).size).toBe(0);
        expect(hostedActions("mc_source")).not.toContain("get_source");
        expect(hostedActions("mc_source", true)).toContain("get_source");
        expect(() => prepareHostedArgs("mc_source", { action: "get_source" }, limits)).toThrow();
        expect(() => prepareHostedArgs("mc_source", { action: "bytecode" }, limits)).toThrow();
        expect(() => prepareHostedArgs("project", { action: "source", className: "net.minecraft.world.Level" }, limits)).toThrow();
        expect(prepareHostedArgs("mc_source", { action: "get_source" }, limits, true).action).toBe("get_source");
    });
});

describe("hosted output boundary", () => {
    it("clips unpaginated source, including JSON-shaped source", () => {
        for (const source of [lines(500), JSON.stringify(Array.from({ length: 500 }, () => "code"), null, 2)]) {
            const result = boundHostedResult("mc_source", { action: "get_source" }, text(source), limits);
            expect(result.content[0]).toMatchObject({ type: "text", text: source.split("\n").slice(0, 200).join("\n") });
        }
    });
    it("preserves already-paginated source and slices raw bytecode exactly once", () => {
        const args = { action: "bytecode", startLine: 201, maxLines: 200 };
        const expected = lines(600).split("\n").slice(200, 400).join("\n");
        const result = boundHostedResult("mc_source", args, text(lines(600)), limits);
        expect(result.content[0]).toMatchObject({ text: expected });
        const project = boundHostedResult("project", args, json({ result: lines(600) }), limits);
        expect(JSON.parse((project.content[0] as any).text).result).toBe(expected);
        for (const tool of ["mc_source", "mod"]) {
            expect(boundHostedResult(tool, { action: tool === "mod" ? "source" : "get_source", startLine: 201 }, text(expected), limits).content[0])
                .toMatchObject({ text: expected });
        }
    });
    it("shares the line cap across snippets and content blocks without breaking JSON", () => {
        const result = boundHostedResult("mc_source", { action: "search_indexed" }, {
            content: [...json([{ snippet: lines(150) }, { snippet: lines(150) }]).content, ...text(lines(50)).content],
        }, limits, true);
        const snippets = JSON.parse((result.content[0] as any).text);
        expect(snippets[0].snippet.split("\n")).toHaveLength(150);
        expect(snippets[1].snippet.split("\n")).toHaveLength(50);
        expect(result.content[1]).toMatchObject({ text: "" });
        expect(result.content.at(-1)).toMatchObject({ text: expect.stringContaining("Response limited") });
    });
    it("projects public Minecraft searches to source-free locations", () => {
        const code = boundHostedResult("mc_source", { action: "search_code" }, json([{ file: "net/minecraft/Test.java", line: 42, text: "SECRET_SOURCE" }]), limits);
        expect(JSON.parse((code.content[0] as any).text)).toEqual([{ file: "net/minecraft/Test.java", line: 42 }]);
        const indexed = boundHostedResult("mc_source", { action: "search_indexed" }, json([{ className: "net/minecraft/Test", snippet: "SECRET_SOURCE" }]), limits);
        expect(JSON.parse((indexed.content[0] as any).text)).toEqual([{ className: "net/minecraft/Test" }]);
        expect(JSON.stringify(code) + JSON.stringify(indexed)).not.toContain("SECRET_SOURCE");
    });
    it("omits Minecraft source matches from public project search", () => {
        const result = boundHostedResult("project", { action: "search" }, json({ results: [
            { className: "net/minecraft/Test", line: 1, text: "SECRET_SOURCE" },
            { className: "org/example/Mod", line: 2, text: "mod code" },
        ] }), limits);
        expect(JSON.parse((result.content[0] as any).text).results).toEqual([{ className: "org/example/Mod", line: 2, text: "mod code" }]);
    });
    it("retains complete class member lists within the byte cap", () => {
        const members = Array.from({ length: 150 }, (_, i) => ({ name: `method${i}`, descriptor: "()V" }));
        const result = boundHostedResult("mc_source", { action: "class_members" }, json({ methods: members }), limits);
        expect(JSON.parse((result.content[0] as any).text).methods).toEqual(members);
    });
    it("handles huge single lines and UTF-8 without malformed output", () => {
        const result = boundHostedResult("mc_source", { action: "get_source" }, text("😀".repeat(100000)), limits);
        expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThanOrEqual(limits.responseBytes);
        expect((result.content[0] as any).text).not.toContain("�");
    });
    it("removes hidden payloads and private paths and rejects binary side channels", () => {
        const result = boundHostedResult("mod", { action: "get" }, {
            ...json({ name: "fixture", jarPath: "secret", nested: { decompPath: "secret", content: "public" } }),
            structuredContent: { source: "HIDDEN" }, _meta: { data: "HIDDEN" },
        }, limits);
        expect(JSON.stringify(result)).not.toMatch(/secret|HIDDEN/);
        expect(() => boundHostedResult("mod", {}, { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }, limits)).toThrow();
        expect(boundHostedResult("mod", {}, { ...text("C:/private/server/stack"), isError: true }, limits)).toMatchObject({ isError: true });
        expect(JSON.stringify(boundHostedResult("mod", {}, { ...text("private"), isError: true }, limits))).not.toContain("private");
    });
});

describe("persistent atomic budgets", () => {
    it("shares counters across budget instances and database connections", async () => {
        const root = mkdtempSync(join(tmpdir(), "modlens-budget-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const file = join(root, "usage.db");
        const a = new HostedBudget(async () => sqliteA, () => 0), sqliteA = sqlite(file);
        await a.charge("user", { ...limits, dailyBytes: 100 }, 1, 80);
        const b = new HostedBudget(async () => sqliteB, () => 0), sqliteB = sqlite(file);
        await expect(b.charge("user", { ...limits, dailyBytes: 100 }, 1, 21)).rejects.toThrow("allowance");
        await b.charge("different-user", { ...limits, dailyBytes: 100 }, 1, 80);
    });
    it("does not overspend when parallel releases race", async () => {
        const db = sqlite();
        const budget = new HostedBudget(async () => db, () => 0);
        const results = await Promise.allSettled(Array.from({ length: 20 }, () => budget.charge("user", { ...limits, dailyBytes: 100 }, 0, 10)));
        expect(results.filter(r => r.status === "fulfilled")).toHaveLength(10);
    });
    it("resets daily usage while retaining the longer period allowance", async () => {
        let now = 0;
        const db = sqlite();
        const budget = new HostedBudget(async () => db, () => now);
        const small = { ...limits, dailyBytes: 100, periodBytes: 150 };
        await budget.charge("user", small, 1, 100);
        now += 86_400_000;
        await budget.charge("user", small, 1, 50);
        await expect(budget.charge("user", small, 1, 1)).rejects.toThrow();
        now = 30 * 86_400_000;
        await budget.charge("user", small, 1, 100);
    });
    it("enforces request rates even for calls returning no source", async () => {
        let now = 0;
        const db = sqlite();
        const budget = new HostedBudget(async () => db, () => now);
        const small = { ...limits, minuteRequests: 1, dailyRequests: 2 };
        await budget.charge("user", small, 1, 0);
        await expect(budget.charge("user", small, 1, 0)).rejects.toThrow();
        now = 60_000;
        await budget.charge("user", small, 1, 0);
        now = 120_000;
        await expect(budget.charge("user", small, 1, 0)).rejects.toThrow();
    });
    it("uses compatible PostgreSQL SQL and bindings", async () => {
        const pg = new PGlite();
        try {
            const db: BudgetDatabase = {
                async $executeRawUnsafe(query) { await pg.exec(query); return 0; },
                async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> { return (await pg.query(query, values)).rows as T; },
            };
            const budget = new HostedBudget(async () => db, () => 0);
            const small = { ...limits, dailyBytes: 10 };
            await budget.charge("user", small, 1, 10);
            await expect(budget.charge("user", small, 1, 1)).rejects.toThrow("allowance");
        } finally { await pg.close(); }
    }, 30000);
    it("charges alternate result routes before release and fails closed", async () => {
        const db = sqlite();
        const budget = new HostedBudget(async () => db, () => 0);
        const result = await runHostedTool("mc_source", { action: "search_code", query: "synthetic" }, "user",
            { ...limits, dailyBytes: 10 }, budget, async () => json([{ snippet: "SECRET_SOURCE" }]));
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("SECRET_SOURCE");
        const run = vi.fn();
        vi.spyOn(console, "error").mockImplementation(() => {});
        const failed = new HostedBudget(async () => { throw new Error("db offline"); });
        expect((await runHostedTool("mc_source", { action: "get_source" }, "user", limits, failed, run)).isError).toBe(true);
        expect(run).not.toHaveBeenCalled();
    });
});
