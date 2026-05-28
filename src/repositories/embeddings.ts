/**
 * Raw SQL helpers for pgvector operations.
 * Prisma doesn't natively support vector types, so all reads/writes go through
 * $queryRawUnsafe / $executeRawUnsafe.
 *
 * Requires: pgvector extension enabled + embedding vector(768) columns on each table.
 * Run `npm run db:vector` once after docker-compose up to enable the extension.
 */
import { getDb } from "../db.js";

type VecRow = { id: number; similarity: number };

function vecLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
}

// ── doc_entries ───────────────────────────────────────────────────────────────

export async function upsertDocEmbedding(id: number, vec: number[]): Promise<void> {
    const db = await getDb();
    await db.$executeRawUnsafe(
        `UPDATE doc_entries SET embedding = $1::vector WHERE id = $2`,
        vecLiteral(vec), id,
    );
}

export async function searchDocsByVector(vec: number[], limit = 5): Promise<VecRow[]> {
    const db = await getDb();
    return db.$queryRawUnsafe<VecRow[]>(
        `SELECT id, (1 - (embedding <=> $1::vector))::float AS similarity
         FROM doc_entries
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vecLiteral(vec), limit,
    );
}

// ── primers ───────────────────────────────────────────────────────────────────

export async function upsertPrimerEmbedding(id: number, vec: number[]): Promise<void> {
    const db = await getDb();
    await db.$executeRawUnsafe(
        `UPDATE primers SET embedding = $1::vector WHERE id = $2`,
        vecLiteral(vec), id,
    );
}

export async function searchPrimersByVector(vec: number[], limit = 5): Promise<VecRow[]> {
    const db = await getDb();
    return db.$queryRawUnsafe<VecRow[]>(
        `SELECT id, (1 - (embedding <=> $1::vector))::float AS similarity
         FROM primers
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vecLiteral(vec), limit,
    );
}

// ── mc_source_files ───────────────────────────────────────────────────────────

export async function upsertSourceEmbedding(id: number, vec: number[], source: string = "local"): Promise<void> {
    const db = await getDb();
    await db.$executeRawUnsafe(
        `UPDATE mc_source_files SET embedding = $1::vector, embed_source = $3, embed_updated_at = NOW() WHERE id = $2`,
        vecLiteral(vec), id, source,
    );
}

export async function searchSourceByVector(
    vec: number[], mcVersionId: number, limit = 10, provenance?: string,
): Promise<Array<{ id: number; class_name: string; similarity: number; embed_source: string | null }>> {
    const db = await getDb();
    if (provenance) {
        return db.$queryRawUnsafe(
            `SELECT id, class_name, embed_source, (1 - (embedding <=> $1::vector))::float AS similarity
             FROM mc_source_files
             WHERE mc_version_id = $3 AND embedding IS NOT NULL AND embed_source = $4
             ORDER BY embedding <=> $1::vector
             LIMIT $2`,
            vecLiteral(vec), limit, mcVersionId, provenance,
        );
    }
    return db.$queryRawUnsafe(
        `SELECT id, class_name, embed_source, (1 - (embedding <=> $1::vector))::float AS similarity
         FROM mc_source_files
         WHERE mc_version_id = $3 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vecLiteral(vec), limit, mcVersionId,
    );
}

/** Count rows with no embedding yet (for backfill progress). */
export async function countUnembedded(table: "doc_entries" | "primers" | "mc_source_files", mcVersionId?: number): Promise<number> {
    const db = await getDb();
    if (table === "mc_source_files" && mcVersionId !== undefined) {
        const rows = await db.$queryRawUnsafe<[{ count: string }]>(
            `SELECT COUNT(*)::text AS count FROM mc_source_files WHERE mc_version_id = $1 AND embedding IS NULL`,
            mcVersionId,
        );
        return parseInt(rows[0].count, 10);
    }
    const rows = await db.$queryRawUnsafe<[{ count: string }]>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE embedding IS NULL`,
    );
    return parseInt(rows[0].count, 10);
}

// ── mod_source_files ──────────────────────────────────────────────────────────

export async function upsertModSourceEmbedding(id: number, vec: number[], source: string = "local"): Promise<void> {
    const db = await getDb();
    await db.$executeRawUnsafe(
        `UPDATE mod_source_files SET embedding = $1::vector, embed_source = $3, embed_updated_at = NOW() WHERE id = $2`,
        vecLiteral(vec), id, source,
    );
}

export async function searchModSourceByVector(
    vec: number[], modId: number, limit = 10, provenance?: string,
): Promise<Array<{ id: number; class_name: string; similarity: number; embed_source: string | null }>> {
    const db = await getDb();
    if (provenance) {
        return db.$queryRawUnsafe(
            `SELECT id, class_name, embed_source, (1 - (embedding <=> $1::vector))::float AS similarity
             FROM mod_source_files
             WHERE mod_id = $3 AND embedding IS NOT NULL AND embed_source = $4
             ORDER BY embedding <=> $1::vector
             LIMIT $2`,
            vecLiteral(vec), limit, modId, provenance,
        );
    }
    return db.$queryRawUnsafe(
        `SELECT id, class_name, embed_source, (1 - (embedding <=> $1::vector))::float AS similarity
         FROM mod_source_files
         WHERE mod_id = $3 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vecLiteral(vec), limit, modId,
    );
}

// ── Class-name → ID lookups (for diff semantic enrichment) ───────────────────

export async function findSourceIdsByClassNames(
    classNames: string[], mcVersionId: number, requireEmbedding = true,
): Promise<Map<string, number>> {
    if (classNames.length === 0) return new Map();
    const db = await getDb();
    const embFilter = requireEmbedding ? " AND embedding IS NOT NULL" : "";
    const rows = await db.$queryRawUnsafe<Array<{ id: number; class_name: string }>>(
        `SELECT id, class_name FROM mc_source_files
         WHERE mc_version_id = $1 AND class_name = ANY($2::text[])${embFilter}`,
        mcVersionId, classNames,
    );
    return new Map(rows.map((r) => [r.class_name, r.id]));
}

export async function findModSourceIdsByClassNames(
    classNames: string[], modId: number, requireEmbedding = true,
): Promise<Map<string, number>> {
    if (classNames.length === 0) return new Map();
    const db = await getDb();
    const embFilter = requireEmbedding ? " AND embedding IS NOT NULL" : "";
    const rows = await db.$queryRawUnsafe<Array<{ id: number; class_name: string }>>(
        `SELECT id, class_name FROM mod_source_files
         WHERE mod_id = $1 AND class_name = ANY($2::text[])${embFilter}`,
        modId, classNames,
    );
    return new Map(rows.map((r) => [r.class_name, r.id]));
}

/** Get embed_source values for a set of source file IDs. */
export async function getEmbedSources(
    table: "mod_source_files" | "mc_source_files", ids: number[],
): Promise<Map<number, { source: string | null; updatedAt: Date | null }>> {
    if (ids.length === 0) return new Map();
    const db = await getDb();
    const rows = await db.$queryRawUnsafe<Array<{ id: number; embed_source: string | null; embed_updated_at: Date | null }>>(
        `SELECT id, embed_source, embed_updated_at FROM ${table} WHERE id = ANY($1::int[]) AND embedding IS NOT NULL`,
        ids,
    );
    return new Map(rows.map((r) => [r.id, { source: r.embed_source, updatedAt: r.embed_updated_at }]));
}

/** Count embeddings by source provenance. */
export async function countEmbedsBySource(
    table: "mod_source_files" | "mc_source_files", scopeColumn: string, scopeId: number,
): Promise<{ local: number; registry: number; community: number; unknown: number }> {
    const db = await getDb();
    const rows = await db.$queryRawUnsafe<Array<{ embed_source: string | null; count: string }>>(
        `SELECT embed_source, COUNT(*)::text AS count FROM ${table}
         WHERE ${scopeColumn} = $1 AND embedding IS NOT NULL
         GROUP BY embed_source`,
        scopeId,
    );
    const result = { local: 0, registry: 0, community: 0, unknown: 0 };
    for (const r of rows) {
        const n = parseInt(r.count, 10);
        if (r.embed_source === "local") result.local += n;
        else if (r.embed_source === "registry") result.registry += n;
        else if (r.embed_source === "community") result.community += n;
        else result.unknown += n;
    }
    return result;
}
