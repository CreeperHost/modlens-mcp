/**
 * Enables the pgvector extension and adds embedding columns to the three tables
 * that support semantic search: doc_entries, primers, mc_source_files.
 *
 * Run once after `docker compose up`:
 *   npm run db:vector
 *
 * Safe to re-run — all statements use IF NOT EXISTS / IF NOT EXISTS.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, "");
    }
}

const prisma = new PrismaClient();

async function main() {
    // 1. Enable extension
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    console.log("✓ pgvector extension enabled");

    // 2. Add embedding columns
    const dim = process.env.OLLAMA_EMBED_DIM ?? "768";
    for (const table of ["doc_entries", "primers", "mc_source_files"]) {
        await prisma.$executeRawUnsafe(
            `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding vector(${dim})`
        );
        console.log(`✓ ${table}.embedding column ready (dim=${dim})`);
    }

    // 3. HNSW indexes for fast approximate nearest-neighbour
    const indexes: Array<[string, string]> = [
        ["doc_entries_embedding_idx",    "doc_entries"],
        ["primers_embedding_idx",        "primers"],
        ["mc_source_files_embedding_idx","mc_source_files"],
    ];
    for (const [idxName, table] of indexes) {
        const existing = await prisma.$queryRawUnsafe<unknown[]>(
            `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1 LIMIT 1`,
            idxName,
        );
        if (Array.isArray(existing) && existing.length > 0) {
            console.log(`  (index ${idxName} already exists — skipping)`);
        } else {
            console.log(`  Creating HNSW index ${idxName}…`);
            await prisma.$executeRawUnsafe(
                `CREATE INDEX ${idxName} ON ${table} USING hnsw (embedding vector_cosine_ops)`
            );
            console.log(`✓ ${idxName} created`);
        }
    }

    console.log("\nDone — semantic search is ready.");
    console.log("Next: set OLLAMA_URL in .env and run   node dist/cli.js backfill-embeddings --type docs");
}

main()
    .catch((err) => { console.error("Failed:", err); process.exit(1); })
    .finally(() => prisma.$disconnect());
