// src/search-adapter.ts
/**
 * Backend-agnostic FTS adapter.
 *
 * Postgres/PGlite: uses native tsvector (mc_source_files) or
 *   case-insensitive LIKE via Prisma's mode:"insensitive".
 * SQLite: uses FTS5 MATCH (mc_source_files) or raw LIKE (docs/primers).
 *   SQLite paths throw until P2 wires them.
 */
import { detectBackend } from "./db-backend.js";
import { getDb } from "./db.js";

export interface FtsSourceResult {
    className: string;
    snippet: string;
}

export interface FtsDocResult {
    id: number;
    class_name: string | null;
    title: string;
    summary: string | null;
    url: string;
    category: string;
    namespace: string;
    tags: string[];
}

export interface FtsPrimerResult {
    id: number;
    title: string;
    summary: string | null;
    from_version: string;
    to_version: string;
    modloader: string | null;
    url: string;
}

// ── mc_source_files FTS ───────────────────────────────────────────────────────

export async function ftsSearchSource(
    mcVersionId: number,
    query: string,
    limit: number,
): Promise<FtsSourceResult[]> {
    const backend = detectBackend();

    if (backend === "sqlite") {
        // Wired in P2
        throw new Error("SQLite FTS for mc_source_files not yet implemented. See P2.");
    }

    // Postgres / PGlite — existing tsvector query
    const db = await getDb();
    type FtsRow = { class_name: string; snippet: string };
    const rows = await db.$queryRaw<FtsRow[]>`
        SELECT
            class_name,
            ts_headline('simple', content,
                plainto_tsquery('simple', ${query}),
                'MaxWords=25, MinWords=15, StartSel="", StopSel=""'
            ) AS snippet
        FROM mc_source_files
        WHERE mc_version_id = ${mcVersionId}
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', ${query})
        ORDER BY ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', ${query})) DESC
        LIMIT ${limit}
    `;
    return rows.map(r => ({ className: r.class_name, snippet: r.snippet }));
}

// ── doc_entries FTS ───────────────────────────────────────────────────────────

export async function ftsSearchDocs(
    query: string,
    limit = 20,
): Promise<FtsDocResult[]> {
    const backend = detectBackend();

    if (backend === "sqlite") {
        // Wired in P2
        throw new Error("SQLite FTS for doc_entries not yet implemented. See P2.");
    }

    // Postgres / PGlite — raw LIKE (case-insensitive via lower())
    const db = await getDb();
    const kw = query.toLowerCase();
    type Row = {
        id: number; class_name: string | null; title: string; summary: string | null;
        url: string; category: string; namespace: string; tags: string[];
    };
    const rows = await db.$queryRaw<Row[]>`
        SELECT id, class_name, title, summary, url, category, namespace, tags
        FROM doc_entries
        WHERE lower(title)      LIKE ${"%" + kw + "%"}
           OR lower(summary)    LIKE ${"%" + kw + "%"}
           OR lower(class_name) LIKE ${"%" + kw + "%"}
        ORDER BY id
        LIMIT ${limit}
    `;
    return rows;
}

// ── primers FTS ───────────────────────────────────────────────────────────────

export async function ftsSearchPrimers(
    query: string,
    modloader?: string,
    limit = 20,
): Promise<FtsPrimerResult[]> {
    const backend = detectBackend();

    if (backend === "sqlite") {
        // Wired in P2
        throw new Error("SQLite FTS for primers not yet implemented. See P2.");
    }

    // Postgres / PGlite — Prisma case-insensitive contains
    const db = await getDb();
    const rows = await db.primer.findMany({
        where: {
            AND: [
                {
                    OR: [
                        { title:   { contains: query, mode: "insensitive" } },
                        { summary: { contains: query, mode: "insensitive" } },
                        { content: { contains: query, mode: "insensitive" } },
                        { tags:    { has: query } },
                    ],
                },
                ...(modloader ? [{ modloader }] : []),
            ],
        },
        select: {
            id: true, title: true, summary: true,
            fromVersion: true, toVersion: true, modloader: true, url: true,
        },
        take: limit,
    });
    return rows.map(r => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        from_version: r.fromVersion,
        to_version: r.toVersion,
        modloader: r.modloader ?? null,
        url: r.url,
    }));
}
