/**
 * Migration guides shared by the MCP, CLI and setup wizard.
 * Content is fetched on demand and cached in the configured database.
 */
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "node:crypto";
import type { Prisma, Primer } from "@prisma/client";
import { getDb } from "../db.js";
import { CACHE_ROOT, exists, ensureDir } from "../cache.js";
import { caseInsensitive, deserializeArray, detectBackend, serializeArray } from "../db-backend.js";
import { embed, isOllamaAvailable, chunkText } from "../embeddings.js";
import { upsertPrimerEmbedding, searchPrimersByVector, countUnembedded } from "../repositories/embeddings.js";
import { SEED_PRIMERS, LEGACY_PRIMER_URLS } from "../primer-catalog.js";
import { fetchPrimerContent, validatePrimerUrl, MAX_PRIMER_CONTENT } from "../primer-content.js";

export { DEFAULT_PRIMER_HOSTS } from "../primer-content.js";

function normalizePrimerTags<T extends { tags: unknown }>(primer: T): Omit<T, "tags"> & { tags: string[] } {
    return { ...primer, tags: deserializeArray<string>(primer.tags) };
}
function serializePrimerTags(tags: string[]): Prisma.PrimerCreateInput["tags"] {
    return serializeArray(tags) as Prisma.PrimerCreateInput["tags"];
}
function primerTagSearchFilters(query: string): Prisma.PrimerWhereInput[] {
    if (detectBackend() !== "sqlite") return [{ tags: { has: query } }];
    return [{ tags: { contains: query, ...caseInsensitive() } } as Prisma.PrimerWhereInput];
}

const VERSIONS_CACHE = join(CACHE_ROOT, "mcmeta", "_latest", "summary", "versions", "data.json");
const VERSIONS_URL = "https://raw.githubusercontent.com/misode/mcmeta/summary/versions/data.json";
type McVersion = { id: string; data_version: number };
let versionsPending: Promise<McVersion[]> | undefined;

async function getVersions(): Promise<McVersion[]> {
    if (!versionsPending) {
        versionsPending = (async () => {
            try {
                if (await exists(VERSIONS_CACHE)) {
                    const cached = JSON.parse(await readFile(VERSIONS_CACHE, "utf8"));
                    if (Array.isArray(cached)) return cached as McVersion[];
                }
            } catch { /* fetch if the cache is missing or corrupt */ }
            const response = await fetch(VERSIONS_URL, { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error("Failed to fetch versions: " + response.status);
            const data: McVersion[] = await response.json();
            if (!Array.isArray(data)) throw new Error("Invalid version catalogue");
            // A read-only cache must not prevent version resolution.
            try { await ensureDir(VERSIONS_CACHE); await writeFile(VERSIONS_CACHE, JSON.stringify(data)); } catch { /* optional cache */ }
            return data;
        })().catch(error => { versionsPending = undefined; throw error; });
    }
    return versionsPending;
}
async function resolveDataVersion(version: string): Promise<number | null> {
    try { return (await getVersions()).find(v => v.id === version)?.data_version ?? null; }
    catch { return null; }
}

/** Stable release fallback when mcmeta is unavailable or has not recorded a version yet. */
function compareRelease(a: string, b: string): number | null {
    if (![a, b].every(v => /^\d+(?:\.\d+){1,2}$/.test(v))) return null;
    const left = a.split(".").map(Number), right = b.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0);
        if (difference) return Math.sign(difference);
    }
    return 0;
}
type VersionRange = {
    fromVersion: string; toVersion: string; fromDataVersion: number | null; toDataVersion: number | null;
};
async function resolveRange(fromVersion: string, toVersion: string): Promise<VersionRange> {
    if (!fromVersion?.trim() || !toVersion?.trim()) throw new Error("fromVersion and toVersion are required");
    const [fromDataVersion, toDataVersion] = await Promise.all([resolveDataVersion(fromVersion), resolveDataVersion(toVersion)]);
    const order = fromDataVersion !== null && toDataVersion !== null
        ? fromDataVersion - toDataVersion : compareRelease(fromVersion, toVersion);
    if (order !== null && order > 0) throw new Error("fromVersion must not be later than toVersion");
    return { fromVersion, toVersion, fromDataVersion, toDataVersion };
}
function overlaps(primer: VersionRange, range: VersionRange): boolean {
    if (range.fromVersion === range.toVersion) return false;
    if ([primer.fromDataVersion, primer.toDataVersion, range.fromDataVersion, range.toDataVersion].every(v => v !== null)) {
        return primer.fromDataVersion! < range.toDataVersion! && primer.toDataVersion! > range.fromDataVersion!;
    }
    const startsBeforeEnd = compareRelease(primer.fromVersion, range.toVersion);
    const endsAfterStart = compareRelease(primer.toVersion, range.fromVersion);
    if (startsBeforeEnd !== null && endsAfterStart !== null) return startsBeforeEnd < 0 && endsAfterStart > 0;
    return primer.fromVersion === range.fromVersion || primer.toVersion === range.toVersion;
}
function comparePrimerVersions(a: VersionRange, b: VersionRange): number {
    const order = a.fromDataVersion !== null && b.fromDataVersion !== null
        ? a.fromDataVersion - b.fromDataVersion : compareRelease(a.fromVersion, b.fromVersion);
    return order ?? a.fromVersion.localeCompare(b.fromVersion);
}
function discoveryWhere(modloader?: string): Prisma.PrimerWhereInput {
    return {
        source: { not: "seed:legacy" },
        ...(modloader ? { modloader: { in: [...new Set([modloader, "vanilla"])] } } : {}),
    };
}
const summarySelect = {
    id: true, fromVersion: true, toVersion: true, fromDataVersion: true, toDataVersion: true,
    modloader: true, title: true, summary: true, url: true, tags: true,
} satisfies Prisma.PrimerSelect;

/**
 * Repair only exact, known legacy seeds. Keep IDs where possible, preserve stored
 * content, and never replace a manually sourced entry sharing a canonical URL.
 * Run lazily as well as during seed so an existing installation repairs on use.
 */
let catalogWork: Promise<unknown> = Promise.resolve();
async function repairPrimerCatalog(seedAll = false): Promise<void> {
    const work = catalogWork.then(async () => {
        const db = await getDb();
        const legacy = await db.primer.findMany({
            where: { source: "seed", url: { in: Object.keys(LEGACY_PRIMER_URLS) } },
        });
        if (!seedAll && !legacy.length) return;
        const seeds = await Promise.all(SEED_PRIMERS.map(async seed => ({
            ...seed, ...await resolveRange(seed.fromVersion, seed.toVersion), tags: serializePrimerTags(seed.tags),
        })));
        await db.$transaction(async tx => {
            for (const old of legacy) {
                const target = seeds.find(seed => seed.url === LEGACY_PRIMER_URLS[old.url]);
                const collision = target && await tx.primer.findUnique({ where: { url: target.url } });
                if (target && !collision && !old.content?.trim()) {
                    await tx.primer.update({ where: { id: old.id }, data: { ...target, content: null } });
                } else {
                    // Retain duplicate/user-populated legacy rows for direct access, but omit them from discovery.
                    await tx.primer.update({ where: { id: old.id }, data: { source: "seed:legacy" } });
                }
            }
            for (const seed of seeds) {
                const existing = await tx.primer.findUnique({ where: { url: seed.url } });
                if (!existing) await tx.primer.create({ data: seed });
                else if (existing.source === "seed") await tx.primer.update({ where: { id: existing.id }, data: seed });
            }
        }, { timeout: 30_000 });
    });
    catalogWork = work.catch(() => {});
    await work;
}

export interface PrimerInput {
    fromVersion: string; toVersion: string; modloader?: string; title: string;
    summary?: string; url: string; content?: string; tags?: string[]; source?: string; fetchContent?: boolean;
}

/** A requested fetch must succeed before the entry is written. */
export async function ingestPrimer(entries: PrimerInput[]) {
    if (!entries?.length) throw new Error("entries must contain at least one primer");
    const results: Array<{ id: number; title: string; fromVersion: string; toVersion: string; contentStatus: string }> = [];
    const errors: Array<{ url: string; error: string }> = [];
    for (const entry of entries) {
        try {
            validatePrimerUrl(entry.url);
            let content = entry.content?.trim() ? entry.content : undefined;
            if (entry.fetchContent && !content) content = await fetchPrimerContent(entry.url);
            if (content && Buffer.byteLength(content, "utf8") > MAX_PRIMER_CONTENT) throw new Error("Primer content exceeds 2 MiB");
            const range = await resolveRange(entry.fromVersion, entry.toVersion);
            const db = await getDb();
            const primer = await db.primer.upsert({
                where: { url: entry.url },
                create: {
                    ...range, modloader: entry.modloader ?? "neoforge", title: entry.title, summary: entry.summary,
                    url: entry.url, content, tags: serializePrimerTags(entry.tags ?? []), source: entry.source ?? "manual",
                },
                update: {
                    ...range, modloader: entry.modloader, title: entry.title, summary: entry.summary,
                    content, tags: entry.tags === undefined ? undefined : serializePrimerTags(entry.tags), source: entry.source,
                },
            });
            results.push({
                id: primer.id, title: primer.title, fromVersion: primer.fromVersion, toVersion: primer.toVersion,
                contentStatus: primer.content?.trim() ? "ready" : "missing",
            });
            await tryEmbedPrimer(primer.id, primer.title, primer.summary, primer.content);
        } catch (error) {
            errors.push({ url: entry.url, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return { ingested: results.length, failed: errors.length, primers: results, errors };
}

const contentLoads = new Map<number, Promise<Primer>>();
async function hydratePrimer(primer: Primer, refresh = false): Promise<Primer> {
    if (!refresh && primer.content?.trim()) return primer;
    let pending = contentLoads.get(primer.id);
    if (!pending) {
        pending = (async () => {
            const content = await fetchPrimerContent(primer.url);
            const db = await getDb();
            // Do not overwrite content edited while the network request was in flight.
            await db.primer.updateMany({
                where: { id: primer.id, url: primer.url, content: primer.content }, data: { content },
            });
            const updated = await db.primer.findUnique({ where: { id: primer.id } });
            if (!updated) throw new Error("Primer was deleted while fetching content");
            await tryEmbedPrimer(updated.id, updated.title, updated.summary, updated.content);
            return updated;
        })().finally(() => { contentLoads.delete(primer.id); });
        contentLoads.set(primer.id, pending);
    }
    return pending;
}

export interface GetPrimerOptions {
    fetchContent?: boolean; refresh?: boolean; startLine?: number; maxLines?: number;
}

/** Return cached Markdown, fetching it if missing. Pagination never truncates the stored guide. */
export async function getPrimer(id: number, options: GetPrimerOptions = {}): Promise<object> {
    const { startLine = 1, maxLines = 400, refresh = false } = options;
    if (!Number.isInteger(id) || id < 1) throw new Error("id must be a positive integer");
    if (!Number.isInteger(startLine) || startLine < 1) throw new Error("startLine must be a positive integer");
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 2000) throw new Error("maxLines must be between 1 and 2000");
    await repairPrimerCatalog();
    const db = await getDb();
    let primer = await db.primer.findUnique({ where: { id } });
    if (!primer) return { found: false, id };
    let redirectedFrom: number | undefined;
    if (primer.source === "seed:legacy") {
        const targetUrl = LEGACY_PRIMER_URLS[primer.url];
        const replacement = targetUrl && await db.primer.findUnique({ where: { url: targetUrl } });
        if (replacement && options.fetchContent !== false && !primer.content?.trim()) {
            redirectedFrom = id;
            primer = replacement;
        } else {
            return {
                ...normalizePrimerTags(primer), contentStatus: "superseded",
                replacementPrimers: (await getPrimersByVersionRange(primer.fromVersion, primer.toVersion, primer.modloader)).primers,
                message: "This old seeded placeholder was retired. Use the replacement primers for the individual migration steps.",
            };
        }
    }
    if (options.fetchContent !== false || refresh) primer = await hydratePrimer(primer, refresh);
    const lines = primer.content?.split("\n") ?? [];
    const end = Math.min(startLine - 1 + maxLines, lines.length);
    return {
        ...normalizePrimerTags(primer),
        content: primer.content ? lines.slice(startLine - 1, end).join("\n") : null,
        contentStatus: primer.content?.trim() ? "ready" : "missing",
        startLine, totalLines: lines.length, truncated: end < lines.length,
        nextStartLine: end < lines.length ? end + 1 : null,
        ...(redirectedFrom === undefined ? {} : { redirectedFrom }),
    };
}

export interface PrimerRangeOptions {
    includeContent?: boolean; fetchContent?: boolean; maxChars?: number; cursor?: string;
}
type PrimerSummary = Omit<Prisma.PrimerGetPayload<{ select: typeof summarySelect }>, "tags"> & { tags: string[] };
type PrimerRangeResult = { queryRange: VersionRange; count: number; primers: PrimerSummary[] };
type BundledPrimer = PrimerSummary & {
    content: string | null; contentStatus: "ready" | "missing" | "fetch_failed";
    startOffset: number; endOffset: number; totalChars: number; truncated: boolean; error?: string;
};
type BundledPrimerRange = Omit<PrimerRangeResult, "primers"> & {
    primers: BundledPrimer[]; failed: number; missing: number; contentChars: number;
    maxChars: number; truncated: boolean; nextCursor: string | null;
};
type PrimerCursor = { v: 1; query: string; id: number; offset: number; hash: string | null };
const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

function parsePrimerCursor(value: string): PrimerCursor {
    try {
        if (typeof value !== "string" || value.length > 2048 || !/^[\w-]+$/.test(value)) throw new Error();
        const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
        if (cursor.v !== 1 || typeof cursor.query !== "string" || !/^[a-f0-9]{64}$/.test(cursor.query) ||
            !Number.isSafeInteger(cursor.id) || cursor.id < 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 ||
            (cursor.offset === 0 ? cursor.hash !== null : typeof cursor.hash !== "string" || !/^[a-f0-9]{64}$/.test(cursor.hash))) throw new Error();
        return cursor;
    } catch { throw new Error("Invalid primer cursor; restart by_version without a cursor"); }
}

/** Each transition strictly overlaps the requested migration; loader queries also include vanilla changes. */
export function getPrimersByVersionRange(fromVersion: string, toVersion: string, modloader: string | undefined,
    options: PrimerRangeOptions & { includeContent: true }): Promise<BundledPrimerRange>;
export function getPrimersByVersionRange(fromVersion: string, toVersion: string, modloader?: string,
    options?: PrimerRangeOptions): Promise<PrimerRangeResult | BundledPrimerRange>;
export async function getPrimersByVersionRange(fromVersion: string, toVersion: string, modloader?: string,
    options: PrimerRangeOptions = {}): Promise<PrimerRangeResult | BundledPrimerRange> {
    if (!options.includeContent && (options.cursor !== undefined || options.maxChars !== undefined)) {
        throw new Error("cursor and maxChars require includeContent: true");
    }
    const maxChars = options.maxChars ?? 60_000;
    if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 200_000) throw new Error("maxChars must be between 1000 and 200000");
    const cursor = options.cursor === undefined ? undefined : parsePrimerCursor(options.cursor);
    await repairPrimerCatalog();
    const range = await resolveRange(fromVersion, toVersion);
    const db = await getDb();
    const rows = await db.primer.findMany({
        where: discoveryWhere(modloader),
        orderBy: [{ fromDataVersion: "asc" }, { fromVersion: "asc" }], select: summarySelect,
    });
    const primers = rows.filter(row => overlaps(row, range)).sort((a, b) => comparePrimerVersions(a, b)
        || (compareRelease(a.toVersion, b.toVersion) ?? a.toVersion.localeCompare(b.toVersion))
        || Number(b.modloader === "vanilla") - Number(a.modloader === "vanilla")
        || a.modloader.localeCompare(b.modloader) || a.id - b.id).map(normalizePrimerTags);
    const result = { queryRange: range, count: primers.length, primers };
    if (!options.includeContent) return result;

    // Bind continuation to both the request and its ordered catalogue. A partly read
    // guide also carries a content hash so edits cannot silently splice two revisions.
    const query = hashText(JSON.stringify([fromVersion, toVersion, modloader ?? null, primers]));
    let index = cursor ? primers.findIndex(primer => primer.id === cursor.id) : 0;
    if (cursor && (cursor.query !== query || index < 0)) throw new Error("Primer range or catalogue changed; restart by_version without a cursor");
    let offset = cursor?.offset ?? 0;
    let contentHash = cursor?.hash ?? null;
    let contentChars = 0;
    const bundled: BundledPrimer[] = [];
    // Bound metadata and concurrent upstream work as well as the combined text.
    page: while (index < primers.length && bundled.length < 20 && contentChars < maxChars) {
        const batch = primers.slice(index, index + Math.min(4, 20 - bundled.length));
        const loaded = await Promise.allSettled(batch.map(async summary => {
            const primer = await db.primer.findUnique({ where: { id: summary.id } });
            if (!primer) throw new Error("Primer was deleted while loading the range");
            return options.fetchContent === false ? primer : hydratePrimer(primer);
        }));
        for (let i = 0; i < batch.length; i++) {
            if (contentChars === maxChars) break page;
            const summary = batch[i], loadedPrimer = loaded[i];
            if (loadedPrimer.status === "rejected") {
                if (offset) throw new Error("Partly read primer is unavailable; restart by_version without a cursor");
                bundled.push({ ...summary, content: null, contentStatus: "fetch_failed", startOffset: 0, endOffset: 0,
                    totalChars: 0, truncated: false, error: loadedPrimer.reason instanceof Error ? loadedPrimer.reason.message : String(loadedPrimer.reason) });
                index++;
                continue;
            }
            const content = loadedPrimer.value.content;
            if (offset && (!content || offset >= content.length || hashText(content) !== contentHash ||
                /[\uD800-\uDBFF]/.test(content[offset - 1]) && /[\uDC00-\uDFFF]/.test(content[offset]))) {
                throw new Error("Partly read primer changed or cursor offset is invalid; restart by_version without a cursor");
            }
            if (!content?.trim()) {
                bundled.push({ ...summary, content: null, contentStatus: "missing", startOffset: 0, endOffset: 0, totalChars: 0, truncated: false });
                index++;
                continue;
            }
            let end = Math.min(content.length, offset + maxChars - contentChars);
            // Never divide a Unicode surrogate pair, even on a single very long line.
            if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
            if (end > offset) bundled.push({ ...summary, content: content.slice(offset, end), contentStatus: "ready",
                startOffset: offset, endOffset: end, totalChars: content.length, truncated: end < content.length });
            contentChars += end - offset;
            if (end < content.length) {
                offset = end;
                contentHash = offset ? hashText(content) : null;
                break page;
            }
            index++;
            offset = 0;
            contentHash = null;
        }
    }
    const nextCursor = index < primers.length
        ? Buffer.from(JSON.stringify({ v: 1, query, id: primers[index].id, offset, hash: contentHash } satisfies PrimerCursor)).toString("base64url") : null;
    return { ...result, primers: bundled, contentChars, maxChars, nextCursor, truncated: nextCursor !== null,
        failed: bundled.filter(primer => primer.contentStatus === "fetch_failed").length,
        missing: bundled.filter(primer => primer.contentStatus === "missing").length };
}

export async function searchPrimers(query: string, modloader?: string, fromVersion?: string, toVersion?: string, limit = 20) {
    await repairPrimerCatalog();
    const range = fromVersion && toVersion ? await resolveRange(fromVersion, toVersion) : undefined;
    const rows = await (await getDb()).primer.findMany({
        where: {
            ...discoveryWhere(modloader),
            ...(!range && fromVersion ? { fromVersion } : {}),
            ...(!range && toVersion ? { toVersion } : {}),
            OR: [
                { title: { contains: query, ...caseInsensitive() } },
                { summary: { contains: query, ...caseInsensitive() } },
                { content: { contains: query, ...caseInsensitive() } },
                ...primerTagSearchFilters(query),
            ],
        },
        orderBy: [{ fromDataVersion: "asc" }, { fromVersion: "asc" }], select: summarySelect,
    });
    const primers = rows.filter(row => !range || overlaps(row, range)).sort(comparePrimerVersions).slice(0, limit).map(normalizePrimerTags);
    return { query, count: primers.length, primers };
}

export async function listPrimers(modloader?: string, limit = 50) {
    await repairPrimerCatalog();
    const rows = await (await getDb()).primer.findMany({
        where: discoveryWhere(modloader), orderBy: [{ fromDataVersion: "asc" }, { fromVersion: "asc" }],
        select: summarySelect,
    });
    const primers = rows.sort(comparePrimerVersions).slice(0, limit).map(normalizePrimerTags);
    return { count: primers.length, primers };
}

export async function deletePrimer(id: number): Promise<object> {
    const deleted = await (await getDb()).primer.delete({ where: { id } }).catch(() => null);
    return { deleted: !!deleted, id };
}

/** Populate the corrected catalogue, fetch missing bodies, and report individual failures for retry. */
export async function seedDefaultPrimers(fetchContent = true) {
    await repairPrimerCatalog(true);
    const db = await getDb();
    const queue = [...SEED_PRIMERS];
    const results: Array<{ id: number; title: string; url: string; contentStatus: string; error?: string }> = [];
    await Promise.all(Array.from({ length: 4 }, async () => {
        let seed;
        while ((seed = queue.shift())) {
            let primer = await db.primer.findUnique({ where: { url: seed.url } });
            if (!primer) continue;
            try {
                if (fetchContent && primer.source === "seed") primer = await hydratePrimer(primer);
                results.push({
                    id: primer.id, title: primer.title, url: primer.url,
                    contentStatus: primer.content?.trim() ? "ready" : "missing",
                });
            } catch (error) {
                results.push({
                    id: primer.id, title: primer.title, url: primer.url, contentStatus: "fetch_failed",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }));
    results.sort((a, b) => a.id - b.id);
    return {
        ingested: results.length, ready: results.filter(r => r.contentStatus === "ready").length,
        failed: results.filter(r => r.contentStatus === "fetch_failed").length, primers: results,
    };
}

async function tryEmbedPrimer(id: number, title: string, summary: string | null | undefined, content: string | null | undefined): Promise<void> {
    try {
        if (!await isOllamaAvailable()) return;
        const parts = [title, summary, content ? chunkText(content, 1500)[0] : undefined].filter(Boolean);
        await upsertPrimerEmbedding(id, await embed(parts.join("\n\n")));
    } catch { /* embeddings are optional */ }
}

export async function semanticSearchPrimers(query: string, limit = 10): Promise<object> {
    await repairPrimerCatalog();
    const rows = await searchPrimersByVector(await embed(query), limit);
    const primers = await (await getDb()).primer.findMany({
        where: { ...discoveryWhere(), id: { in: rows.map(r => r.id) } }, select: summarySelect,
    });
    const byId = new Map(primers.map(p => [p.id, p]));
    const results = rows.flatMap(row => {
        const primer = byId.get(row.id);
        return primer ? [{ similarity: Math.round(row.similarity * 1000) / 1000, ...normalizePrimerTags(primer) }] : [];
    });
    return { query, semantic: true, count: results.length, results };
}

export async function backfillPrimerEmbeddings(): Promise<object> {
    await repairPrimerCatalog();
    if (!await isOllamaAvailable()) return { error: "Ollama is not available. Set OLLAMA_URL and ensure Ollama is running." };
    const rows = await (await getDb()).primer.findMany({
        where: discoveryWhere(), select: { id: true, title: true, summary: true, content: true },
    });
    const unembedded = await countUnembedded("primers");
    let done = 0, failed = 0;
    for (const row of rows) {
        try {
            const parts = [row.title, row.summary, row.content ? chunkText(row.content, 1500)[0] : undefined].filter(Boolean);
            await upsertPrimerEmbedding(row.id, await embed(parts.join("\n\n")));
            done++;
        } catch { failed++; }
    }
    return { total: rows.length, wasUnembedded: unembedded, embedded: done, failed };
}
