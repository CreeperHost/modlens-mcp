/**
 * Creates the PostgreSQL GIN index for full-text search on mc_source_files.
 * Run via: npm run db:setup
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a Prisma migration transaction,
 * so it lives here as a post-migrate step.
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
    // Check if the index already exists to avoid a no-op CONCURRENTLY call
    const existing = await prisma.$queryRaw`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename  = 'mc_source_files'
          AND indexname  = 'mc_source_files_tsv_idx'
        LIMIT 1
    `;

    if (Array.isArray(existing) && existing.length > 0) {
        console.log("FTS index mc_source_files_tsv_idx already exists — skipping.");
        return;
    }

    console.log("Creating GIN FTS index on mc_source_files(content) — this may take a while...");
    // CONCURRENTLY cannot run inside a transaction; Prisma $executeRaw runs outside one here.
    await prisma.$executeRawUnsafe(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS mc_source_files_tsv_idx
            ON mc_source_files USING GIN (to_tsvector('simple', content))
    `);
    console.log("Done: mc_source_files_tsv_idx created.");
}

main()
    .catch((err) => { console.error("Failed to create FTS index:", err); process.exit(1); })
    .finally(() => prisma.$disconnect());
