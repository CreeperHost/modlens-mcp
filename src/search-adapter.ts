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

/** Escape LIKE metacharacters so user input is matched literally. */
function escapeLike(s: string): string {
    return s.replace(/[%_\\]/g, c => "\\" + c);
}

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
        const url = process.env.DATABASE_URL ?? "";
        const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(path, { readonly: true });
        try {
            type Row = { id: number; content: string; class_name: string };
            const rows = db.prepare(
                `SELECT s.id, s.class_name, s.content FROM fts_mc_source f
                 JOIN mc_source_files s ON s.id = f.rowid
                 WHERE f.fts_mc_source MATCH ? AND s.mc_version_id = ?
                 ORDER BY rank
                 LIMIT ?`,
            ).all(query, mcVersionId, limit) as Row[];
            return rows.map(r => ({
                className: r.class_name,
                snippet: r.content.slice(0, 300),
            }));
        } finally {
            db.close();
        }
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

// ── mod_source_files FTS (fabric / neoforge / forge / quilt) ─────────────────

/**
 * BM25-ranked FTS search over mod source files.
 * SQLite: fts_mod_source FTS5 table (ORDER BY rank = BM25).
 * PostgreSQL: to_tsvector GIN index + ts_rank.
 * Mod source must be indexed first (mod index_fts or index_semantic action).
 */
export async function ftsSearchModSource(
    modId: number,
    query: string,
    limit: number,
): Promise<FtsSourceResult[]> {
    const backend = detectBackend();

    if (backend === "sqlite") {
        const url = process.env.DATABASE_URL ?? "";
        const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(path, { readonly: true });
        try {
            type Row = { id: number; content: string; class_name: string };
            const rows = db.prepare(
                `SELECT s.id, s.class_name, s.content FROM fts_mod_source f
                 JOIN mod_source_files s ON s.id = f.rowid
                 WHERE f.fts_mod_source MATCH ? AND s.mod_id = ?
                 ORDER BY rank
                 LIMIT ?`,
            ).all(query, modId, limit) as Row[];
            return rows.map(r => ({
                className: r.class_name,
                snippet: r.content.slice(0, 300),
            }));
        } finally {
            db.close();
        }
    }

    // PostgreSQL — GIN index on to_tsvector('simple', content)
    const db = await getDb();
    type FtsRow = { class_name: string; snippet: string };
    const rows = await db.$queryRaw<FtsRow[]>`
        SELECT
            class_name,
            ts_headline('simple', content,
                plainto_tsquery('simple', ${query}),
                'MaxWords=25, MinWords=15, StartSel="", StopSel=""'
            ) AS snippet
        FROM mod_source_files
        WHERE mod_id = ${modId}
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
        const url = process.env.DATABASE_URL ?? "";
        const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(path, { readonly: true });
        try {
            type Row = {
                id: number; class_name: string | null; title: string; summary: string | null;
                url: string; category: string; namespace: string; tags: string;
            };
            const rows = db.prepare(
                `SELECT d.id, d.class_name, d.title, d.summary, d.url, d.category, d.namespace, d.tags
                 FROM fts_doc_entries f
                 JOIN doc_entries d ON d.id = f.rowid
                 WHERE f.fts_doc_entries MATCH ?
                 ORDER BY rank
                 LIMIT ?`,
            ).all(query, limit) as Row[];
            return rows.map(r => ({ ...r, tags: JSON.parse(r.tags ?? "[]") as string[] }));
        } finally {
            db.close();
        }
    }

    // Postgres / PGlite — raw LIKE (case-insensitive via lower())
    const db = await getDb();
    const kw = escapeLike(query.toLowerCase());
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
        const url = process.env.DATABASE_URL ?? "";
        const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(path, { readonly: true });
        try {
            type Row = {
                id: number; title: string; summary: string | null;
                from_version: string; to_version: string; modloader: string | null; url: string;
            };
            const rows = db.prepare(
                `SELECT p.id, p.title, p.summary, p.from_version, p.to_version, p.modloader, p.url
                 FROM fts_primers f
                 JOIN primers p ON p.id = f.rowid
                 WHERE f.fts_primers MATCH ?
                 ${modloader ? "AND p.modloader = ?" : ""}
                 ORDER BY rank
                 LIMIT ?`,
            ).all(...[query, ...(modloader ? [modloader] : []), limit]) as Row[];
            return rows.map(r => ({
                id: r.id, title: r.title, summary: r.summary,
                from_version: r.from_version, to_version: r.to_version,
                modloader: r.modloader ?? null, url: r.url,
            }));
        } finally {
            db.close();
        }
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
