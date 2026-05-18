/**
 * Creates the mod_source_files table and a pgvector column for semantic search.
 * Run via: node scripts/migrate-mod-source-files.mjs
 *
 * Safe to re-run — uses IF NOT EXISTS / DO $$ guards throughout.
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
    // 1. Create table (no embedding column here — enable-pgvector.mjs owns that
    //    so the correct OLLAMA_EMBED_DIM dimension is always used)
    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS mod_source_files (
            id         SERIAL PRIMARY KEY,
            mod_id     INTEGER NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
            class_name TEXT    NOT NULL,
            content    TEXT    NOT NULL,
            UNIQUE (mod_id, class_name)
        )
    `);
    console.log("✓ mod_source_files table ready");

    // 2. B-tree index on mod_id
    await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS mod_source_files_mod_id_idx
        ON mod_source_files (mod_id)
    `);
    console.log("✓ mod_source_files_mod_id_idx ready");

    // 3. GIN index for FTS (same pattern as mc_source_files)
    const ftsExists = await prisma.$queryRaw`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename  = 'mod_source_files'
          AND indexname  = 'mod_source_files_tsv_idx'
    `;
    if (ftsExists.length === 0) {
        await prisma.$executeRawUnsafe(`
            CREATE INDEX CONCURRENTLY mod_source_files_tsv_idx
            ON mod_source_files
            USING GIN (to_tsvector('simple', content))
        `);
        console.log("✓ mod_source_files_tsv_idx (GIN FTS) created");
    } else {
        console.log("  mod_source_files_tsv_idx already exists, skipping");
    }

    console.log("\nDone. Run 'npm run db:vector' to add the embedding column with the correct dimension.");
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
