/**
 * MCP tools for version migration "primers".
 *
 * Primers document how to migrate mods/projects from one Minecraft version to another
 * (e.g. NeoForge breaking changes, Forge migration guides).
 *
 * Stored in the `primers` Postgres table.
 * fromDataVersion / toDataVersion are the integer data_version values from mcmeta,
 * enabling numeric range queries without fragile string comparisons.
 */
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { db } from "../db.js";
import { Prisma } from "@prisma/client";
import { CACHE_ROOT, exists, ensureDir } from "../cache.js";
import { embed, isOllamaAvailable, chunkText } from "../embeddings.js";
import { upsertPrimerEmbedding, searchPrimersByVector, countUnembedded } from "../repositories/embeddings.js";

// ── Version resolution ────────────────────────────────────────────────────────
const VERSIONS_CACHE = join(CACHE_ROOT, "mcmeta", "_latest", "summary", "versions", "data.json");
const VERSIONS_URL   = "https://raw.githubusercontent.com/misode/mcmeta/summary/versions/data.json";

type McVersion = {
    id: string;
    type: string;
    stable: boolean;
    data_version: number;
    release_time: string;
};

let _versionsCache: McVersion[] | null = null;

async function getVersions(): Promise<McVersion[]> {
    if (_versionsCache) return _versionsCache;
    try {
        if (await exists(VERSIONS_CACHE)) {
            const text = (await readFile(VERSIONS_CACHE)).toString("utf8");
            _versionsCache = JSON.parse(text);
            return _versionsCache!;
        }
    } catch { /* fall through to fetch */ }
    const res = await fetch(VERSIONS_URL);
    if (!res.ok) throw new Error(`Failed to fetch versions: ${res.status}`);
    const data: McVersion[] = await res.json();
    await ensureDir(VERSIONS_CACHE);
    await writeFile(VERSIONS_CACHE, JSON.stringify(data));
    _versionsCache = data;
    return data;
}

/** Resolve a version string to its integer data_version (null if unknown). */
async function resolveDataVersion(versionId: string): Promise<number | null> {
    try {
        const versions = await getVersions();
        const v = versions.find(v => v.id === versionId);
        return v?.data_version ?? null;
    } catch {
        return null;
    }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/** Ingest one or more primers into the database. */
export async function ingestPrimer(entries: {
    fromVersion: string;
    toVersion: string;
    modloader?: string;
    title: string;
    summary?: string;
    url: string;
    content?: string;
    tags?: string[];
    source?: string;
    fetchContent?: boolean;
}[]): Promise<object> {
    const results: Array<{ id: number; title: string; fromVersion: string; toVersion: string }> = [];

    for (const e of entries) {
        // Optionally fetch content from URL
        let content = e.content;
        if (e.fetchContent && !content) {
            try {
                const res = await fetch(e.url);
                if (res.ok) {
                    const text = await res.text();
                    // Strip HTML tags for readability (basic)
                    content = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 50_000);
                }
            } catch { /* ignore fetch errors */ }
        }

        // Resolve numeric data versions
        const [fromDV, toDV] = await Promise.all([
            resolveDataVersion(e.fromVersion),
            resolveDataVersion(e.toVersion),
        ]);

        // Upsert by url
        const primer = await db().primer.upsert({
            where: { url: e.url } as Prisma.PrimerWhereUniqueInput,
            create: {
                fromVersion: e.fromVersion,
                toVersion: e.toVersion,
                fromDataVersion: fromDV,
                toDataVersion: toDV,
                modloader: e.modloader ?? "neoforge",
                title: e.title,
                summary: e.summary,
                url: e.url,
                content,
                tags: e.tags ?? [],
                source: e.source ?? "manual",
            },
            update: {
                fromVersion: e.fromVersion,
                toVersion: e.toVersion,
                fromDataVersion: fromDV,
                toDataVersion: toDV,
                modloader: e.modloader ?? "neoforge",
                title: e.title,
                summary: e.summary,
                url: e.url,
                content: content ?? undefined,
                tags: e.tags ?? [],
            },
        });
        results.push({ id: primer.id, title: primer.title, fromVersion: primer.fromVersion, toVersion: primer.toVersion });
        await tryEmbedPrimer(primer.id, primer.title, primer.summary, content);
    }

    return { ingested: results.length, primers: results };
}

/** Get a single primer by ID. */
export async function getPrimer(id: number): Promise<object> {
    const primer = await db().primer.findUnique({ where: { id } });
    if (!primer) return { found: false, id };
    return primer;
}

/**
 * Get primers for a version range.
 * Returns all primers where the primer's version range overlaps with [fromVersion, toVersion].
 * If both data versions are resolvable, uses numeric comparison.
 * Otherwise falls back to exact string match on fromVersion/toVersion.
 */
export async function getPrimersByVersionRange(
    fromVersion: string,
    toVersion: string,
    modloader?: string,
): Promise<object> {
    const [fromDV, toDV] = await Promise.all([
        resolveDataVersion(fromVersion),
        resolveDataVersion(toVersion),
    ]);

    let where: Prisma.PrimerWhereInput;

    if (fromDV !== null && toDV !== null) {
        // Overlap condition: primer.fromDV <= toDV AND primer.toDV >= fromDV
        where = {
            AND: [
                { fromDataVersion: { lte: toDV } },
                { toDataVersion: { gte: fromDV } },
                ...(modloader ? [{ modloader }] : []),
            ],
        };
    } else {
        // Fallback: primers where either bound matches exactly
        where = {
            OR: [
                { fromVersion },
                { toVersion },
                { fromVersion: toVersion },
                { toVersion: fromVersion },
            ],
            ...(modloader ? { modloader } : {}),
        };
    }

    const primers = await db().primer.findMany({
        where,
        orderBy: [{ fromDataVersion: "asc" }, { fromVersion: "asc" }],
        select: {
            id: true,
            fromVersion: true,
            toVersion: true,
            fromDataVersion: true,
            toDataVersion: true,
            modloader: true,
            title: true,
            summary: true,
            url: true,
            tags: true,
        },
    });

    return {
        queryRange: { fromVersion, toVersion, fromDataVersion: fromDV, toDataVersion: toDV },
        count: primers.length,
        primers,
    };
}

/** Search primers using full-text search on title, summary, and content. */
export async function searchPrimers(
    query: string,
    modloader?: string,
    fromVersion?: string,
    toVersion?: string,
    limit = 20,
): Promise<object> {
    // Resolve version bounds if provided
    const [fromDV, toDV] = await Promise.all([
        fromVersion ? resolveDataVersion(fromVersion) : Promise.resolve(null),
        toVersion ? resolveDataVersion(toVersion) : Promise.resolve(null),
    ]);

    const versionFilter: Prisma.PrimerWhereInput[] = [];
    if (fromDV !== null && toDV !== null) {
        versionFilter.push({ fromDataVersion: { lte: toDV } });
        versionFilter.push({ toDataVersion: { gte: fromDV } });
    } else if (fromVersion) {
        versionFilter.push({ fromVersion });
    }

    const primers = await db().primer.findMany({
        where: {
            AND: [
                {
                    OR: [
                        { title: { contains: query, mode: "insensitive" } },
                        { summary: { contains: query, mode: "insensitive" } },
                        { content: { contains: query, mode: "insensitive" } },
                        { tags: { has: query } },
                    ],
                },
                ...(modloader ? [{ modloader }] : []),
                ...versionFilter,
            ],
        },
        orderBy: [{ fromDataVersion: "asc" }, { fromVersion: "asc" }],
        take: limit,
        select: {
            id: true,
            fromVersion: true,
            toVersion: true,
            modloader: true,
            title: true,
            summary: true,
            url: true,
            tags: true,
        },
    });

    return { query, count: primers.length, primers };
}

/** List all primers with optional filters. */
export async function listPrimers(
    modloader?: string,
    limit = 50,
): Promise<object> {
    const primers = await db().primer.findMany({
        where: modloader ? { modloader } : {},
        orderBy: [{ fromDataVersion: "asc" }, { fromVersion: "asc" }],
        take: limit,
        select: {
            id: true,
            fromVersion: true,
            toVersion: true,
            modloader: true,
            title: true,
            summary: true,
            url: true,
            tags: true,
        },
    });
    return { count: primers.length, primers };
}

/** Delete a primer by ID. */
export async function deletePrimer(id: number): Promise<object> {
    const deleted = await db().primer.delete({ where: { id } }).catch(() => null);
    return { deleted: !!deleted, id };
}

// ── Default seed data ─────────────────────────────────────────────────────────

const SEED_PRIMERS: Parameters<typeof ingestPrimer>[0] = [
    // ── NeoForge migration guides ─────────────────────────────────────────
    {
        fromVersion: "1.20.4",
        toVersion: "1.21.1",
        modloader: "neoforge",
        title: "NeoForge Migration Guide — 1.20.4 to 1.21.x",
        summary: "Official NeoForge migration documentation covering breaking API changes, event system overhauls, registry changes, and data component migration from 1.20.4 through 1.21.1.",
        url: "https://docs.neoforged.net/docs/1.21.x/migrationguide/",
        tags: ["neoforge", "migration", "1.20.4", "1.21.1", "events", "registries"],
        source: "seed",
    },
    {
        fromVersion: "1.20.1",
        toVersion: "1.20.4",
        modloader: "neoforge",
        title: "NeoForge Migration Guide — 1.20.1 to 1.20.4",
        summary: "NeoForge was forked from MinecraftForge during 1.20.1. This guide covers the initial NeoForge migration from Forge including package renames, event system changes, and new capability system.",
        url: "https://docs.neoforged.net/docs/1.20.4/migrationguide/",
        tags: ["neoforge", "migration", "1.20.1", "1.20.4", "forge-fork", "capabilities"],
        source: "seed",
    },
    {
        fromVersion: "1.21.1",
        toVersion: "1.21.5",
        modloader: "neoforge",
        title: "NeoForge Migration Guide — 1.21.1 to 1.21.5",
        summary: "Migration guide covering NeoForge API changes between 1.21.1 and 1.21.5, including inventory, recipe, and rendering API updates.",
        url: "https://docs.neoforged.net/docs/1.21.5/migrationguide/",
        tags: ["neoforge", "migration", "1.21.1", "1.21.5"],
        source: "seed",
    },
    {
        fromVersion: "1.21.5",
        toVersion: "26.1.2",
        modloader: "neoforge",
        title: "NeoForge Migration Guide — 1.21.5 to 26.1.2",
        summary: "Migration guide for the Minecraft version numbering change (1.21.x → 26.x) and corresponding NeoForge API updates.",
        url: "https://docs.neoforged.net/docs/current/migrationguide/",
        tags: ["neoforge", "migration", "1.21.5", "26.1.2", "versioning"],
        source: "seed",
    },
    // ── NeoForge breaking changes page ────────────────────────────────────
    {
        fromVersion: "1.20.1",
        toVersion: "26.1.2",
        modloader: "neoforge",
        title: "NeoForge Documentation — Getting Started",
        summary: "Main NeoForge documentation landing page covering setup, versioning, and links to all migration guides.",
        url: "https://docs.neoforged.net/docs/gettingstarted/",
        tags: ["neoforge", "setup", "docs"],
        source: "seed",
    },
    // ── MinecraftForge primers (pre-NeoForge split) ──────────────────────
    {
        fromVersion: "1.19.4",
        toVersion: "1.20.1",
        modloader: "forge",
        title: "MinecraftForge Migration — 1.19.4 to 1.20.1",
        summary: "MinecraftForge breaking changes from 1.19.4 to 1.20.1 including registry changes, chat changes, and creative tab API overhaul.",
        url: "https://github.com/MinecraftForge/MinecraftForge/blob/1.20.1/Changelog.md",
        tags: ["forge", "migration", "1.19.4", "1.20.1"],
        source: "seed",
    },
    {
        fromVersion: "1.18.2",
        toVersion: "1.19.4",
        modloader: "forge",
        title: "MinecraftForge Migration — 1.18.2 to 1.19.x",
        summary: "MinecraftForge breaking changes for 1.19.x series including the component damage system, fluid API, and rendering changes.",
        url: "https://github.com/MinecraftForge/MinecraftForge/blob/1.19.4/Changelog.md",
        tags: ["forge", "migration", "1.18.2", "1.19.4"],
        source: "seed",
    },
    // ── Fabric migration notes ────────────────────────────────────────────
    {
        fromVersion: "1.20.4",
        toVersion: "1.21.1",
        modloader: "fabric",
        title: "Fabric — Migration Primer 1.20.4 to 1.21.1",
        summary: "Fabric API breaking changes guide for 1.20.4 → 1.21.x covering rendering API updates, item stack changes, and the new item components system.",
        url: "https://fabricmc.net/wiki/tutorial:migration",
        tags: ["fabric", "migration", "1.20.4", "1.21.1"],
        source: "seed",
    },
    // ── NeoForge CHANGELOG ────────────────────────────────────────────────
    {
        fromVersion: "1.20.1",
        toVersion: "26.1.2",
        modloader: "neoforge",
        title: "NeoForge GitHub CHANGELOG",
        summary: "Full NeoForge changelog on GitHub tracking all API additions, removals, and fixes across all supported MC versions.",
        url: "https://github.com/neoforged/NeoForge/blob/main/CHANGELOG.md",
        tags: ["neoforge", "changelog", "all-versions"],
        source: "seed",
    },
];

/** Populate the primers table with known NeoForge/Forge/Fabric migration guides. */
export async function seedDefaultPrimers(): Promise<object> {
    return ingestPrimer(SEED_PRIMERS);
}

// ── embedding helpers ─────────────────────────────────────────────────────────

async function tryEmbedPrimer(
    id: number, title: string, summary: string | null | undefined, content: string | undefined,
): Promise<void> {
    if (!await isOllamaAvailable()) return;
    try {
        // Embed title + summary + first chunk of content
        const parts = [title, summary, content ? chunkText(content, 1500)[0] : undefined].filter(Boolean);
        const vec = await embed(parts.join("\n\n"));
        await upsertPrimerEmbedding(id, vec);
    } catch { /* non-fatal */ }
}

// ── semantic_search ───────────────────────────────────────────────────────────

export async function semanticSearchPrimers(query: string, limit = 10): Promise<object> {
    const vec = await embed(query);
    const rows = await searchPrimersByVector(vec, limit);
    if (!rows.length) return { query, semantic: true, count: 0, results: [] };
    const ids = rows.map(r => r.id);
    const primers = await db().primer.findMany({
        where: { id: { in: ids } },
        select: { id: true, fromVersion: true, toVersion: true, modloader: true, title: true, summary: true, url: true, tags: true },
    });
    const byId = Object.fromEntries(primers.map(p => [p.id, p]));
    const results = rows.map(r => ({ similarity: Math.round(r.similarity * 1000) / 1000, ...byId[r.id] }));
    return { query, semantic: true, count: results.length, results };
}

// ── backfill_embeddings ───────────────────────────────────────────────────────

export async function backfillPrimerEmbeddings(): Promise<object> {
    if (!await isOllamaAvailable()) {
        return { error: "Ollama is not available. Set OLLAMA_URL and ensure Ollama is running." };
    }
    const rows = await db().primer.findMany({ select: { id: true, title: true, summary: true, content: true } });
    const unembedded = await countUnembedded("primers");
    let done = 0; let failed = 0;
    for (const row of rows) {
        try {
            const parts = [row.title, row.summary, row.content ? chunkText(row.content, 1500)[0] : undefined].filter(Boolean);
            const vec = await embed(parts.join("\n\n"));
            await upsertPrimerEmbedding(row.id, vec);
            done++;
        } catch { failed++; }
    }
    return { total: rows.length, wasUnembedded: unembedded, embedded: done, failed };
}
