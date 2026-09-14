// Live upstream check, isolated from the user's database/cache. Run after npm run build.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "modlens-primers-live-"));
await copyFile(join(repository, "prisma/backends/template.db"), join(root, "test.db"));
process.env.DATABASE_URL = "file:" + join(root, "test.db");
process.env.MODLENS_CACHE_ROOT = join(root, "cache");
process.env.OLLAMA_URL = "http://127.0.0.1:1"; // Embeddings are independent of this check.
const { getDb, disconnect } = await import("../dist/db.js");
const { seedDefaultPrimers, getPrimer, getPrimersByVersionRange } = await import("../dist/tools/primers.js");
const { SEED_PRIMERS } = await import("../dist/primer-catalog.js");
const db = await getDb();
let passed = false;
try {
    await db.primer.create({ data: {
        id: 3, fromVersion: "1.21.1", toVersion: "1.21.5", modloader: "neoforge",
        title: "NeoForge Migration Guide - 1.21.1 to 1.21.5 (content)",
        url: "https://docs.neoforged.net/docs/1.21.5/migrationguide/", source: "seed",
    } });
    console.log("Fetching the official primer catalogue into a disposable SQLite database...");
    const seeded = await seedDefaultPrimers();
    console.log(JSON.stringify({ guides: seeded.ingested, ready: seeded.ready, failed: seeded.failed,
        errors: seeded.primers.filter(p => p.error) }, null, 2));
    assert.equal(seeded.ready, SEED_PRIMERS.length);
    assert.equal(seeded.failed, 0);
    const range = await getPrimersByVersionRange("1.21.1", "1.21.5", "neoforge");
    assert.equal(range.count, 6);
    const fullRange = await getPrimersByVersionRange("1.21.1", "26.1", "neoforge");
    assert.equal(fullRange.count, 17);
    const bundledContent = new Map();
    let cursor;
    let bundlePages = 0;
    do {
        const bundle = await getPrimersByVersionRange("1.21.1", "26.1", "neoforge", { includeContent: true, maxChars: 60_000, cursor });
        assert.equal(bundle.failed, 0);
        assert.equal(bundle.missing, 0);
        assert.equal(bundle.count, 17);
        assert.ok(bundle.contentChars <= 60_000);
        for (const primer of bundle.primers) {
            const previous = bundledContent.get(primer.id) ?? "";
            assert.equal(primer.startOffset, previous.length);
            bundledContent.set(primer.id, previous + primer.content);
        }
        cursor = bundle.nextCursor ?? undefined;
        assert.ok(++bundlePages < 100, "Bundle pagination must terminate");
    } while (cursor);
    for (const primer of fullRange.primers) {
        const stored = await db.primer.findUniqueOrThrow({ where: { id: primer.id } });
        assert.equal(bundledContent.get(primer.id), stored.content, `Bundle must retain all content for ${primer.title}`);
    }
    const reported = await getPrimer(3);
    assert.equal(reported.url, "https://docs.neoforged.net/primer/docs/1.21.5/");
    assert.equal(reported.contentStatus, "ready");
    const saved = await db.primer.findUniqueOrThrow({ where: { id: 3 } });
    assert.ok(saved.content.length > 50_000, "The guide must survive the old 50K truncation limit");
    assert.ok(saved.content.includes(String.fromCharCode(96).repeat(3)), "Code fences must survive extraction");
    assert.match(saved.content, /var blocker = new BlocksAttacks\(\n\s+\/\//, "Highlighted code must preserve line breaks before comments");
    let page = reported;
    const parts = [];
    while (true) {
        parts.push(page.content);
        if (page.nextStartLine === null) break;
        page = await getPrimer(3, { startLine: page.nextStartLine });
    }
    assert.equal(parts.join("\n"), saved.content);
    const neo = range.primers.find(p => p.toVersion === "1.21.5" && p.modloader === "neoforge");
    const loader = await db.primer.findUniqueOrThrow({ where: { id: neo.id } });
    assert.match(loader.content, /Embedded source: https:\/\/neoforged.net\/news\/21.5release\//);
    // A restarted, disconnected client should still be able to read the cached body.
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => { throw new Error("Offline check"); };
        await disconnect();
        assert.equal((await getPrimer(3)).content, reported.content);
        const offlineBundle = await getPrimersByVersionRange("1.21.1", "26.1", "neoforge", { includeContent: true });
        assert.equal(offlineBundle.failed, 0);
        assert.ok(offlineBundle.contentChars > 0);
    } finally { globalThis.fetch = originalFetch; }
    console.log("PASS: legacy ID repaired, live guide extraction, 17-guide range bundling, lossless pagination, and offline cached reads");
    console.log(JSON.stringify({ reportGuideCharacters: saved.content.length, reportGuideLines: reported.totalLines, pages: parts.length, bundleGuides: bundledContent.size, bundlePages }));
    passed = true;
} finally {
    await disconnect();
    if (passed) {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()), "Cleanup must stay within the test temp directory");
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
    } else console.error("Live primer test artifacts retained at " + root);
}
