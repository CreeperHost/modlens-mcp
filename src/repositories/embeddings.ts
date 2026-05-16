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

export async function upsertSourceEmbedding(id: number, vec: number[]): Promise<void> {
    const db = await getDb();
    await db.$executeRawUnsafe(
        `UPDATE mc_source_files SET embedding = $1::vector WHERE id = $2`,
        vecLiteral(vec), id,
    );
}

export async function searchSourceByVector(
    vec: number[], mcVersionId: number, limit = 10,
): Promise<Array<{ id: number; class_name: string; similarity: number }>> {
    const db = await getDb();
    return db.$queryRawUnsafe<Array<{ id: number; class_name: string; similarity: number }>>(
        `SELECT id, class_name, (1 - (embedding <=> $1::vector))::float AS similarity
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
