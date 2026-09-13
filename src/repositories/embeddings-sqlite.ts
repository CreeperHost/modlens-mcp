/**
 * sqlite-vec helpers for vector operations on a SQLite backend.
 * Uses float32 blobs and cosine distance, with scope filters before the limit.
 * Existing vec0 tables are kept in sync when present; searches also work on
 * databases created without those optional indexes.
 */
import { sqliteDatabasePath } from "../sqlite-schema.js";

type VecRow = { id: number; similarity: number };

let _vecDb: import("better-sqlite3").Database | null = null;

async function getVecDb(): Promise<import("better-sqlite3").Database> {
    if (_vecDb) return _vecDb;
    const url = process.env.DATABASE_URL ?? "";
    const path = sqliteDatabasePath(url);
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path);
    try {
        const { createRequire } = await import("module");
        const require = createRequire(import.meta.url);
        const sqliteVec = require("sqlite-vec");
        sqliteVec.load(db);
    } catch {
        db.close();
        throw new Error("SQLite vector search requires the sqlite-vec package. Reinstall ModLens with optional dependencies enabled.");
    }
    _vecDb = db;
    return db;
}

export function closeVecDb(): void {
    _vecDb?.close();
    _vecDb = null;
}

function float32Blob(vec: number[]): Buffer {
    if (!vec.length || vec.some(value => !Number.isFinite(value))) throw new Error("Embedding must be a non-empty finite vector");
    const buf = Buffer.allocUnsafe(vec.length * 4);
    for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
    return buf;
}

// ── doc_entries ───────────────────────────────────────────────────────────────

export async function upsertDocEmbedding(id: number, vec: number[]): Promise<void> {
    const db = await getVecDb();
    // Store blob in Prisma table
    const prisma = await import("../db.js").then((m) => m.getDb());
    await (prisma as any).docEntry.update({ where: { id }, data: { embedding: float32Blob(vec) } });
    // Upsert into vec0 table if available
    try {
        db.prepare(`INSERT OR REPLACE INTO vec_doc_entries(rowid, embedding) VALUES (?, ?)`).run(id, float32Blob(vec));
    } catch { /* vec0 unavailable */ }
}

export async function searchDocsByVector(vec: number[], limit = 5): Promise<VecRow[]> {
    const db = await getVecDb();
    return db.prepare(`SELECT id, 1 - vec_distance_cosine(embedding, ?) AS similarity
        FROM doc_entries WHERE embedding IS NOT NULL ORDER BY similarity DESC LIMIT ?`
    ).all(float32Blob(vec), limit) as VecRow[];
}

// ── primers ───────────────────────────────────────────────────────────────────

export async function upsertPrimerEmbedding(id: number, vec: number[]): Promise<void> {
    const db = await getVecDb();
    const prisma = await import("../db.js").then((m) => m.getDb());
    await (prisma as any).primer.update({ where: { id }, data: { embedding: float32Blob(vec) } });
    try {
        db.prepare(`INSERT OR REPLACE INTO vec_primers(rowid, embedding) VALUES (?, ?)`).run(id, float32Blob(vec));
    } catch { /* vec0 unavailable */ }
}

export async function searchPrimersByVector(vec: number[], limit = 5): Promise<VecRow[]> {
    const db = await getVecDb();
    return db.prepare(`SELECT id, 1 - vec_distance_cosine(embedding, ?) AS similarity
        FROM primers WHERE embedding IS NOT NULL ORDER BY similarity DESC LIMIT ?`
    ).all(float32Blob(vec), limit) as VecRow[];
}

// ── mc_source_files ───────────────────────────────────────────────────────────

export async function upsertSourceEmbedding(id: number, vec: number[], source: string = "local"): Promise<void> {
    const db = await getVecDb();
    const prisma = await import("../db.js").then((m) => m.getDb());
    await (prisma as any).mcSourceFile.update({ where: { id }, data: { embedding: float32Blob(vec), embedSource: source, embedUpdatedAt: new Date() } });
    try {
        db.prepare(`INSERT OR REPLACE INTO vec_mc_source(rowid, embedding) VALUES (?, ?)`).run(id, float32Blob(vec));
    } catch { /* vec0 unavailable */ }
}

export async function searchSourceByVector(
    vec: number[], mcVersionId: number, limit = 10, provenance?: string,
): Promise<Array<{ id: number; class_name: string; similarity: number; embed_source: string | null }>> {
    const db = await getVecDb();
    return db.prepare(`SELECT id, class_name, embed_source, 1 - vec_distance_cosine(embedding, ?) AS similarity
        FROM mc_source_files WHERE mc_version_id = ? AND embedding IS NOT NULL
        ${provenance ? "AND embed_source = ?" : ""} ORDER BY similarity DESC LIMIT ?`
    ).all(float32Blob(vec), mcVersionId, ...(provenance ? [provenance] : []), limit) as Array<{ id: number; class_name: string; similarity: number; embed_source: string | null }>;
}

// ── mod_source_files ──────────────────────────────────────────────────────────

export async function upsertModSourceEmbedding(id: number, vec: number[], source: string = "local"): Promise<void> {
    const db = await getVecDb();
    const prisma = await import("../db.js").then((m) => m.getDb());
    await (prisma as any).modSourceFile.update({ where: { id }, data: { embedding: float32Blob(vec), embedSource: source, embedUpdatedAt: new Date() } });
    try {
        db.prepare(`INSERT OR REPLACE INTO vec_mod_source(rowid, embedding) VALUES (?, ?)`).run(id, float32Blob(vec));
    } catch { /* vec0 unavailable */ }
}

export async function searchModSourceByVector(
    vec: number[], modId: number, limit = 10, provenance?: string,
): Promise<Array<{ id: number; class_name: string; similarity: number; embed_source: string | null }>> {
    const db = await getVecDb();
    return db.prepare(`SELECT id, class_name, embed_source, 1 - vec_distance_cosine(embedding, ?) AS similarity
        FROM mod_source_files WHERE mod_id = ? AND embedding IS NOT NULL
        ${provenance ? "AND embed_source = ?" : ""} ORDER BY similarity DESC LIMIT ?`
    ).all(float32Blob(vec), modId, ...(provenance ? [provenance] : []), limit) as Array<{ id: number; class_name: string; similarity: number; embed_source: string | null }>;
}

// ── Class-name → ID lookups (for diff semantic enrichment) ───────────────────

export async function findSourceIdsByClassNames(
    classNames: string[], mcVersionId: number, requireEmbedding = true,
): Promise<Map<string, number>> {
    if (classNames.length === 0) return new Map();
    const db = await getVecDb();
    const placeholders = classNames.map(() => "?").join(",");
    const embFilter = requireEmbedding ? " AND embedding IS NOT NULL" : "";
    try {
        const rows = db.prepare(
            `SELECT id, class_name FROM mc_source_files
             WHERE mc_version_id = ? AND class_name IN (${placeholders})${embFilter}`,
        ).all(mcVersionId, ...classNames) as Array<{ id: number; class_name: string }>;
        return new Map(rows.map((r) => [r.class_name, r.id]));
    } catch {
        return new Map();
    }
}

export async function findModSourceIdsByClassNames(
    classNames: string[], modId: number, requireEmbedding = true,
): Promise<Map<string, number>> {
    if (classNames.length === 0) return new Map();
    const db = await getVecDb();
    const placeholders = classNames.map(() => "?").join(",");
    const embFilter = requireEmbedding ? " AND embedding IS NOT NULL" : "";
    try {
        const rows = db.prepare(
            `SELECT id, class_name FROM mod_source_files
             WHERE mod_id = ? AND class_name IN (${placeholders})${embFilter}`,
        ).all(modId, ...classNames) as Array<{ id: number; class_name: string }>;
        return new Map(rows.map((r) => [r.class_name, r.id]));
    } catch {
        return new Map();
    }
}

/** Get embed_source values for a set of source file IDs. */
export async function getEmbedSources(
    table: "mod_source_files" | "mc_source_files", ids: number[],
): Promise<Map<number, { source: string | null; updatedAt: Date | null }>> {
    if (ids.length === 0) return new Map();
    const db = await getVecDb();
    const placeholders = ids.map(() => "?").join(",");
    try {
        const rows = db.prepare(
            `SELECT id, embed_source, embed_updated_at FROM ${table}
             WHERE id IN (${placeholders}) AND embedding IS NOT NULL`,
        ).all(...ids) as Array<{ id: number; embed_source: string | null; embed_updated_at: string | null }>;
        return new Map(rows.map((r) => [r.id, {
            source: r.embed_source,
            updatedAt: r.embed_updated_at ? new Date(r.embed_updated_at) : null,
        }]));
    } catch {
        return new Map();
    }
}

/** Count embeddings by source provenance. */
export async function countEmbedsBySource(
    table: "mod_source_files" | "mc_source_files", scopeColumn: string, scopeId: number,
): Promise<{ local: number; registry: number; community: number; unknown: number }> {
    const db = await getVecDb();
    const result = { local: 0, registry: 0, community: 0, unknown: 0 };
    try {
        const rows = db.prepare(
            `SELECT embed_source, COUNT(*) AS count FROM ${table}
             WHERE ${scopeColumn} = ? AND embedding IS NOT NULL
             GROUP BY embed_source`,
        ).all(scopeId) as Array<{ embed_source: string | null; count: number }>;
        for (const r of rows) {
            if (r.embed_source === "local") result.local += r.count;
            else if (r.embed_source === "registry") result.registry += r.count;
            else if (r.embed_source === "community") result.community += r.count;
            else result.unknown += r.count;
        }
    } catch { /* columns may not exist yet */ }
    return result;
}
