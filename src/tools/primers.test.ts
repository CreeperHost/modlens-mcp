import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SEED_PRIMERS } from "../primer-catalog.js";

vi.mock("../embeddings.js", () => ({
    isOllamaAvailable: vi.fn(async () => false), embed: vi.fn(), chunkText: vi.fn(),
}));

const legacyUrl = "https://docs.neoforged.net/docs/1.21.5/migrationguide/";
const canonicalUrl = "https://docs.neoforged.net/primer/docs/1.21.5/";
const markdown = "# Migration notes\n\n" + Array.from({ length: 600 }, (_, i) => "Guide line " + (i + 1)).join("\n");
const input = {
    fromVersion: "1.21.1", toVersion: "1.21.5", modloader: "neoforge",
    title: "Custom guide", url: "https://docs.neoforged.net/custom",
};
const versions = ["1.20.4", "1.20.5", "1.20.6", "1.21", "1.21.1", "1.21.2", "1.21.4", "1.21.5", "1.21.6"]
    .map((id, i) => ({ id, data_version: 3900 + i * 100 }));

describe("primer storage and upgrade flow (real SQLite)", () => {
    let fixtureRoot: string;
    let root: string;
    let db: Awaited<ReturnType<typeof import("../db.js").getDb>>;
    let disconnect: typeof import("../db.js").disconnect;
    let primers: typeof import("./primers.js");
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeAll(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), "modlens-primer-schema-"));
        const template = join(fixtureRoot, "template.db");
        await writeFile(template, "");
        execFileSync(process.execPath, [
            createRequire(import.meta.url).resolve("prisma/build/index.js"), "db", "push", "--skip-generate",
            "--schema", fileURLToPath(new URL("../../prisma/backends/schema.sqlite.prisma", import.meta.url)),
        ], { env: { ...process.env, DATABASE_URL: "file:" + template.replaceAll("\\", "/"), PRISMA_HIDE_UPDATE_MESSAGE: "1" }, stdio: "pipe" });
    }, 30_000);
    afterAll(async () => {
        expect(dirname(resolve(fixtureRoot))).toBe(resolve(tmpdir()));
        await rm(fixtureRoot, { recursive: true, force: true });
    });
    beforeEach(async () => {
        vi.resetModules();
        root = await mkdtemp(join(tmpdir(), "modlens-primer-test-"));
        await copyFile(join(fixtureRoot, "template.db"), join(root, "test.db"));
        vi.stubEnv("DATABASE_URL", "file:" + join(root, "test.db"));
        vi.stubEnv("MODLENS_CACHE_ROOT", join(root, "cache"));
        fetchMock = vi.fn(async (url: string) => url.includes("misode/mcmeta")
            ? Response.json(versions)
            : new Response(markdown, { headers: { "content-type": "text/markdown" } }));
        vi.stubGlobal("fetch", fetchMock);
        ({ disconnect } = await import("../db.js"));
        db = await (await import("../db.js")).getDb();
        primers = await import("./primers.js");
    });
    afterEach(async () => {
        await disconnect?.();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
        await rm(root, { recursive: true, force: true });
    });
    async function legacy(content?: string) {
        return db.primer.create({ data: { ...input, id: 3, url: legacyUrl, title: "Old guide (content)", source: "seed", content } });
    }

    it("repairs the reported seeded ID, fetches a real guide URL, and caches the complete body", async () => {
        await legacy();
        const page = await primers.getPrimer(3) as any;
        expect(page).toMatchObject({
            id: 3, url: canonicalUrl, fromVersion: "1.21.4", toVersion: "1.21.5",
            modloader: "vanilla", contentStatus: "ready", startLine: 1, nextStartLine: 401, truncated: true,
        });
        expect(page.tags).toContain("migration");
        expect(page.content).toContain("# Migration notes");
        expect(fetchMock.mock.calls.some(([url]) => url === legacyUrl)).toBe(false);
        expect((await db.primer.findUniqueOrThrow({ where: { id: 3 } })).content).toBe(markdown);
        const tail = await primers.getPrimer(3, { startLine: 401 }) as any;
        expect(tail).toMatchObject({ nextStartLine: null, truncated: false });
        expect(tail.content).toContain("Guide line 600");
        expect(fetchMock.mock.calls.filter(([url]) => url === canonicalUrl)).toHaveLength(1);
    });

    it("finds the six intervening vanilla/NeoForge guides without adjacent transitions", async () => {
        await legacy();
        const result = await primers.getPrimersByVersionRange("1.21.1", "1.21.5", "neoforge");
        expect(result.count).toBe(6);
        expect(result.primers.map(p => p.toVersion)).toEqual(["1.21.2", "1.21.2", "1.21.4", "1.21.4", "1.21.5", "1.21.5"]);
        expect(new Set(result.primers.map(p => p.modloader))).toEqual(new Set(["vanilla", "neoforge"]));
        expect((await primers.getPrimersByVersionRange("1.21.5", "1.21.5", "neoforge")).count).toBe(0);
        const search = await primers.searchPrimers("migration", "neoforge", "1.21.1", "1.21.5");
        expect(search.count).toBe(6);
        await expect(primers.getPrimersByVersionRange("1.21.5", "1.21.1")).rejects.toThrow("fromVersion");
    });

    it("uses numeric release components for uncatalogued versions rather than lexical or exact-only matching", async () => {
        await primers.seedDefaultPrimers(false);
        const result = await primers.getPrimersByVersionRange("1.21.9", "1.21.11", "neoforge");
        expect(result.primers.map(p => p.toVersion)).toEqual(["1.21.10", "1.21.11", "1.21.11"]);
    });

    it("bundles the complete 1.21.1 to 26.1 range with vanilla before loader guides and caches the bodies", async () => {
        await primers.seedDefaultPrimers(false);
        fetchMock.mockClear();
        const metadata = await primers.getPrimersByVersionRange("1.21.1", "26.1", "neoforge");
        expect(metadata.count).toBe(17);
        expect(metadata.primers.every(primer => !("content" in primer))).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        const body = "# Migration notes\n\n" + "Readable migration instructions. ".repeat(5);
        fetchMock.mockImplementation(async () => new Response(body, { headers: { "content-type": "text/markdown" } }));
        const bundle = await primers.getPrimersByVersionRange("1.21.1", "26.1", "neoforge", { includeContent: true });
        expect(bundle).toMatchObject({ count: 17, failed: 0, missing: 0, nextCursor: null, truncated: false });
        expect(bundle.primers.map(primer => primer.id)).toEqual(metadata.primers.map(primer => primer.id));
        expect(bundle.primers.map(primer => primer.modloader).slice(0, 4)).toEqual(["vanilla", "neoforge", "vanilla", "neoforge"]);
        expect(bundle.primers.at(-1)).toMatchObject({ fromVersion: "1.21.11", toVersion: "26.1", modloader: "neoforge" });
        expect(bundle.primers.every(primer => primer.content === body.trim() && primer.url && primer.title && primer.tags.includes("migration"))).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(17);
        fetchMock.mockRejectedValue(new Error("offline"));
        expect(await primers.getPrimersByVersionRange("1.21.1", "26.1", "neoforge", { includeContent: true })).toEqual(bundle);
        expect(await primers.getPrimersByVersionRange("26.1", "26.1", "neoforge", { includeContent: true }))
            .toMatchObject({ count: 0, primers: [], contentChars: 0, failed: 0, nextCursor: null });
    });

    it("reconstructs multiple guides exactly across shared budgets, long lines, and Unicode boundaries", async () => {
        const bodies = ["a".repeat(999) + "😀" + "b".repeat(1500) + "\n\n", "c".repeat(1000), "😀".repeat(900)];
        const saved = await primers.ingestPrimer(bodies.map((content, i) => ({ ...input, url: input.url + i, content })));
        const reconstructed = new Map<number, string>();
        let cursor: string | undefined;
        let pages = 0;
        do {
            const bundle = await primers.getPrimersByVersionRange("1.21.1", "1.21.5", "neoforge", { includeContent: true, maxChars: 1000, cursor });
            expect(bundle.count).toBe(3);
            expect(bundle.failed).toBe(0);
            expect(bundle.contentChars).toBeLessThanOrEqual(1000);
            expect(bundle.contentChars).toBeGreaterThan(0);
            expect(bundle.contentChars).toBe(bundle.primers.reduce((sum, primer) => sum + primer.content!.length, 0));
            for (const primer of bundle.primers) {
                const previous = reconstructed.get(primer.id) ?? "";
                expect(primer.startOffset).toBe(previous.length);
                expect(primer.endOffset).toBe(previous.length + primer.content!.length);
                expect(primer.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
                reconstructed.set(primer.id, previous + primer.content);
            }
            cursor = bundle.nextCursor ?? undefined;
            expect(++pages).toBeLessThan(10);
        } while (cursor);
        expect(saved.primers.map(primer => reconstructed.get(primer.id))).toEqual(bodies);
    });

    it("continues at an exact guide boundary and bounds pages of missing content", async () => {
        await primers.ingestPrimer(Array.from({ length: 23 }, (_, i) => ({ ...input, url: input.url + i, content: i < 2 ? "x".repeat(1000) : undefined })));
        const first = await primers.getPrimersByVersionRange("1.21.1", "1.21.5", undefined, { includeContent: true, maxChars: 1000, fetchContent: false });
        expect(first.primers).toHaveLength(1);
        expect(first.primers[0].truncated).toBe(false);
        const second = await primers.getPrimersByVersionRange("1.21.1", "1.21.5", undefined, { includeContent: true, cursor: first.nextCursor!, fetchContent: false });
        expect(second.primers).toHaveLength(20);
        expect(second.primers[0].startOffset).toBe(0);
        expect(second).toMatchObject({ count: 23, missing: 19, contentChars: 1000, truncated: true });
        const last = await primers.getPrimersByVersionRange("1.21.1", "1.21.5", undefined, { includeContent: true, cursor: second.nextCursor!, fetchContent: false });
        expect(last).toMatchObject({ missing: 2, contentChars: 0, nextCursor: null });
        expect(new Set([...first.primers, ...second.primers, ...last.primers].map(primer => primer.id)).size).toBe(23);
    });

    it("reports per-guide failures without dropping successful or offline-missing guides", async () => {
        const saved = await primers.ingestPrimer([
            { ...input, url: input.url + "/ready", content: markdown },
            { ...input, url: input.url + "/broken" },
            { ...input, url: input.url + "/fetch" },
        ]);
        fetchMock.mockClear();
        const offline = await primers.getPrimersByVersionRange("1.21.1", "1.21.5", undefined, { includeContent: true, fetchContent: false });
        expect(offline).toMatchObject({ failed: 0, missing: 2, nextCursor: null });
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockImplementation(async (url: string) => url.endsWith("/broken") ? new Response("gone", { status: 404 })
            : new Response(markdown, { headers: { "content-type": "text/markdown" } }));
        const bundle = await primers.getPrimersByVersionRange("1.21.1", "1.21.5", undefined, { includeContent: true });
        expect(bundle).toMatchObject({ count: 3, failed: 1, missing: 0, nextCursor: null });
        expect(bundle.primers.map(primer => primer.contentStatus)).toEqual(["ready", "fetch_failed", "ready"]);
        expect(bundle.primers[1].error).toContain("HTTP 404");
        expect(bundle.primers[0].content).toBe(markdown);
        expect((await db.primer.findUniqueOrThrow({ where: { id: saved.primers[1].id } })).content).toBeNull();
    });

    it("rejects invalid, mismatched, and stale continuation cursors", async () => {
        const saved = await primers.ingestPrimer([{ ...input, content: "x".repeat(2500) }]);
        const options = { includeContent: true as const, maxChars: 1000 };
        const first = await primers.getPrimersByVersionRange("1.21.1", "1.21.5", "neoforge", options);
        for (const cursor of ["garbage", "", "x".repeat(2049), Buffer.from("null").toString("base64url")]) {
            await expect(primers.getPrimersByVersionRange("1.21.1", "1.21.5", "neoforge", { ...options, cursor })).rejects.toThrow("Invalid primer cursor");
        }
        await expect(primers.getPrimersByVersionRange("1.21.1", "1.21.5", "fabric", { ...options, cursor: first.nextCursor! })).rejects.toThrow("range or catalogue changed");
        const forged = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString());
        forged.offset = 2500;
        await expect(primers.getPrimersByVersionRange("1.21.1", "1.21.5", "neoforge", { ...options, cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") })).rejects.toThrow("offset is invalid");
        await db.primer.update({ where: { id: saved.primers[0].id }, data: { content: "y".repeat(2500) } });
        await expect(primers.getPrimersByVersionRange("1.21.1", "1.21.5", "neoforge", { ...options, cursor: first.nextCursor! })).rejects.toThrow("Partly read primer changed");
        await primers.ingestPrimer([{ ...input, url: input.url + "/added", content: markdown }]);
        await expect(primers.getPrimersByVersionRange("1.21.1", "1.21.5", "neoforge", { ...options, cursor: first.nextCursor! })).rejects.toThrow("range or catalogue changed");
        for (const maxChars of [0, 999, 200001, 1000.5, NaN]) {
            await expect(primers.getPrimersByVersionRange("1.21.1", "1.21.5", undefined, { includeContent: true, maxChars })).rejects.toThrow("maxChars");
        }
        await expect(primers.getPrimersByVersionRange("1.21.1", "1.21.5", undefined, { cursor: first.nextCursor! })).rejects.toThrow("includeContent");
    });

    it("serves cached content offline and preserves it after a failed refresh", async () => {
        const saved = await primers.ingestPrimer([{ ...input, content: markdown, tags: ["keep"] }]);
        fetchMock.mockRejectedValue(new Error("offline"));
        const page = await primers.getPrimer(saved.primers[0].id) as any;
        expect(page.contentStatus).toBe("ready");
        await expect(primers.getPrimer(page.id, { refresh: true })).rejects.toThrow("offline");
        expect((await db.primer.findUniqueOrThrow({ where: { id: page.id } })).content).toBe(markdown);
    });

    it("reports missing bodies explicitly for metadata-only reads and fetch errors on normal reads", async () => {
        const saved = await primers.ingestPrimer([input]);
        fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
        const page = await primers.getPrimer(saved.primers[0].id, { fetchContent: false }) as any;
        expect(page).toMatchObject({ content: null, contentStatus: "missing", totalLines: 0 });
        await expect(primers.getPrimer(page.id)).rejects.toThrow("HTTP 404");
        expect((await db.primer.findUniqueOrThrow({ where: { id: page.id } })).content).toBeNull();
    });

    it("does not persist failed requested fetches or discard metadata during a content update", async () => {
        const saved = await primers.ingestPrimer([{ ...input, modloader: "fabric", content: markdown, tags: ["keep"], source: "custom" }]);
        fetchMock.mockImplementation(async (url: string) => url.endsWith("/broken")
            ? new Response("gone", { status: 404 }) : Response.json(versions));
        const failed = await primers.ingestPrimer([{ ...input, url: input.url + "/broken", fetchContent: true }]);
        expect(failed).toMatchObject({ ingested: 0, failed: 1 });
        expect(failed.errors[0].error).toContain("HTTP 404");
        expect(await db.primer.count()).toBe(1);
        const { modloader: _, ...update } = input;
        await primers.ingestPrimer([{ ...update, content: markdown + "\nUpdated" }]);
        const page = await primers.getPrimer(saved.primers[0].id) as any;
        expect(page).toMatchObject({ tags: ["keep"], source: "custom", modloader: "fabric" });
    });

    it("reports partial seed failures and retries only missing guides", async () => {
        fetchMock.mockImplementation(async (url: string) => url.includes("misode/mcmeta") ? Response.json(versions)
            : url === canonicalUrl ? new Response("gone", { status: 404 })
            : new Response(markdown, { headers: { "content-type": "text/markdown" } }));
        const seeded = await primers.seedDefaultPrimers();
        expect(seeded).toMatchObject({ ingested: SEED_PRIMERS.length, ready: SEED_PRIMERS.length - 1, failed: 1 });
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(new Response(markdown, { headers: { "content-type": "text/markdown" } }));
        const retry = await primers.seedDefaultPrimers();
        expect(retry).toMatchObject({ ready: SEED_PRIMERS.length, failed: 0 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(canonicalUrl);
    });

    it("preserves manual entries at seed URLs and old entries with stored content", async () => {
        await legacy("User-supplied legacy content");
        const manual = await db.primer.create({ data: {
            ...input, url: canonicalUrl, source: "manual", title: "Keep this title", content: markdown,
        } });
        await primers.seedDefaultPrimers(false);
        expect((await db.primer.findUniqueOrThrow({ where: { id: manual.id } })).title).toBe("Keep this title");
        expect((await db.primer.findUniqueOrThrow({ where: { id: 3 } })).content).toBe("User-supplied legacy content");
        const old = await primers.getPrimer(3) as any;
        expect(old.contentStatus).toBe("superseded");
        expect(old.replacementPrimers.length).toBeGreaterThan(0);
        expect((await primers.listPrimers()).primers.some(p => p.id === 3)).toBe(false);
    });

    it("redirects empty duplicate IDs to their replacement and retires non-guide placeholders", async () => {
        await legacy();
        const target = await db.primer.create({ data: { ...input, url: canonicalUrl, source: "seed" } });
        const placeholder = await db.primer.create({ data: {
            ...input, url: "https://docs.neoforged.net/docs/gettingstarted/", source: "seed",
        } });
        expect(await primers.getPrimer(3)).toMatchObject({ id: target.id, redirectedFrom: 3, contentStatus: "ready" });
        expect(await primers.getPrimer(placeholder.id)).toMatchObject({ contentStatus: "superseded", content: null });
        expect(fetchMock.mock.calls.some(([url]) => url.includes("gettingstarted"))).toBe(false);
    });

    it("deduplicates concurrent fetches and protects edits made while a fetch is running", async () => {
        const saved = await primers.ingestPrimer([input]);
        let release!: (response: Response) => void;
        let started!: () => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        fetchMock.mockImplementation(() => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
        const first = primers.getPrimer(saved.primers[0].id);
        const second = primers.getPrimer(saved.primers[0].id);
        await entered;
        await db.primer.update({ where: { id: saved.primers[0].id }, data: { content: "New manual edit" } });
        release(new Response(markdown, { headers: { "content-type": "text/markdown" } }));
        const pages = await Promise.all([first, second]);
        expect(pages).toEqual(expect.arrayContaining([expect.objectContaining({ content: "New manual edit" })]));
        expect((await db.primer.findUniqueOrThrow({ where: { id: saved.primers[0].id } })).content).toBe("New manual edit");
        // One mcmeta request during ingest, and one content request.
        expect(fetchMock.mock.calls.filter(([url]) => url === input.url)).toHaveLength(1);
    });
});
