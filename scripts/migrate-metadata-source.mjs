/**
 * Add metadata_source column to the mods table.
 * Safe to re-run — uses IF NOT EXISTS / duplicate column guards.
 *
 * Usage: node scripts/migrate-metadata-source.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

try { require("dotenv").config(); } catch { /* optional */ }

const dbUrl = process.env.DATABASE_URL ?? "";

function detectBackend(url) {
    if (url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
    if (url.startsWith("pglite://") || url.startsWith("pglite:")) return "pglite";
    return "postgres";
}

async function migrateSqlite() {
    const Database = require("better-sqlite3");
    const path = dbUrl.replace(/^file:\/\//, "").replace(/^file:/, "");
    const db = new Database(path);
    try {
        db.exec(`ALTER TABLE mods ADD COLUMN metadata_source TEXT`);
        console.log("  + mods.metadata_source");
    } catch (e) {
        if (e.message?.includes("duplicate column")) {
            console.log("  = mods.metadata_source (already exists)");
        } else {
            throw e;
        }
    }
    db.close();
}

async function migratePostgres() {
    const { Client } = require("pg");
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(`ALTER TABLE mods ADD COLUMN IF NOT EXISTS metadata_source TEXT`);
    console.log("  + mods.metadata_source");
    await client.end();
}

async function migratePglite() {
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = dbUrl.replace(/^pglite:\/\//, "").replace(/^pglite:/, "");
    const db = new PGlite(dataDir);
    await db.exec(`ALTER TABLE mods ADD COLUMN IF NOT EXISTS metadata_source TEXT`);
    console.log("  + mods.metadata_source");
    await db.close();
}

const backend = detectBackend(dbUrl);
console.log(`Migrating metadata_source column (${backend})...`);

if (backend === "sqlite") await migrateSqlite();
else if (backend === "pglite") await migratePglite();
else await migratePostgres();

console.log("Done.");
