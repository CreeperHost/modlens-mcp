/**
 * Add embed_source and embed_updated_at columns to mc_source_files and mod_source_files.
 * Safe to re-run — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards.
 *
 * Usage: node scripts/migrate-embed-provenance.mjs
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

const TABLES = ["mc_source_files", "mod_source_files"];
const COLUMNS = [
    { name: "embed_source",     pgType: "TEXT",        sqliteType: "TEXT" },
    { name: "embed_updated_at", pgType: "TIMESTAMPTZ", sqliteType: "DATETIME" },
];

async function migrateSqlite() {
    const Database = require("better-sqlite3");
    const path = dbUrl.replace(/^file:\/\//, "").replace(/^file:/, "");
    const db = new Database(path);
    for (const table of TABLES) {
        for (const col of COLUMNS) {
            try {
                db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.sqliteType}`);
                console.log(`  + ${table}.${col.name}`);
            } catch (e) {
                if (e.message?.includes("duplicate column")) {
                    console.log(`  = ${table}.${col.name} (already exists)`);
                } else {
                    throw e;
                }
            }
        }
    }
    db.close();
}

async function migratePostgres() {
    const { Client } = require("pg");
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    for (const table of TABLES) {
        for (const col of COLUMNS) {
            await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${col.pgType}`);
            console.log(`  + ${table}.${col.name}`);
        }
    }
    await client.end();
}

async function migratePglite() {
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = dbUrl.replace(/^pglite:\/\//, "").replace(/^pglite:/, "");
    const db = new PGlite(dataDir);
    for (const table of TABLES) {
        for (const col of COLUMNS) {
            await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${col.pgType}`);
            console.log(`  + ${table}.${col.name}`);
        }
    }
    await db.close();
}

const backend = detectBackend(dbUrl);
console.log(`Migrating embed provenance columns (${backend})...`);

if (backend === "sqlite") await migrateSqlite();
else if (backend === "pglite") await migratePglite();
else await migratePostgres();

console.log("Done.");
