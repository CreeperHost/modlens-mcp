/**
 * Profile-aware post-update script.
 * Called by `npm run update` after git pull + npm install + build.
 * Reads DATABASE_URL / MODLENS_PROFILE from .env and runs the correct
 * schema migration + vector extension commands for the user's backend.
 *
 * Safe to re-run — all underlying scripts use IF NOT EXISTS guards.
 */
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const envPath = join(ROOT, ".env");

// ── Load .env ─────────────────────────────────────────────────────────────────
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, "");
    }
}

const dbUrl = process.env.DATABASE_URL ?? "";

function run(cmd) {
    console.log(`\n> ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

// ── Detect backend from DATABASE_URL prefix ───────────────────────────────────
let backend;
if (dbUrl.startsWith("postgresql://") || dbUrl.startsWith("postgres://")) {
    backend = "postgres";
} else if (dbUrl.startsWith("pglite://") || dbUrl.startsWith("pglite:")) {
    backend = "pglite";
} else if (dbUrl.startsWith("file:")) {
    backend = "sqlite";
} else {
    console.warn(`⚠ Could not detect backend from DATABASE_URL="${dbUrl}". Defaulting to postgres.`);
    backend = "postgres";
}

console.log(`\nDetected backend: ${backend}`);

// ── Apply schema ──────────────────────────────────────────────────────────────
if (backend === "sqlite") {
    // SQLite uses a separate schema file — db push is safest (no migration files)
    run("npx prisma db push --schema prisma/backends/schema.sqlite.prisma --accept-data-loss");
} else {
    // Postgres and PGlite both use the main schema
    // prisma migrate deploy applies any new migration files; db push is the fallback
    // for dev setups that use db push instead of migrate
    try {
        run("npx prisma migrate deploy");
    } catch {
        console.log("  migrate deploy failed (likely db-push setup) — falling back to db push");
        run("npx prisma db push");
    }
    // Extra post-migrate steps for Postgres (GIN FTS indexes, mod_source_files table)
    if (backend === "postgres") {
        run("node scripts/create-fts-index.mjs");
        run("node scripts/migrate-mod-source-files.mjs");
    }
}

// ── Vector extension ──────────────────────────────────────────────────────────
if (backend === "sqlite") {
    run("node scripts/enable-sqlite-vec.mjs");
} else {
    // Postgres and PGlite: adds/resizes embedding columns to match OLLAMA_EMBED_DIM
    run("node scripts/enable-pgvector.mjs");
}

console.log("\n✓ Update complete. Restart your MCP client to load the new server.");
