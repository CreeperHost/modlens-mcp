// scripts/migrate-backend.mjs
/**
 * Migrate core modlens data between backends.
 *
 * Usage:
 *   SOURCE_DATABASE_URL=postgresql://... DATABASE_URL=pglite:///path node scripts/migrate-backend.mjs
 *
 * Migrates: mods, mod_classes, mod_tags, doc_entries, primers.
 * Skips:    mc_versions, mc_source_files (too large — user re-indexes).
 * Safe:     uses INSERT OR IGNORE (SQLite) / ON CONFLICT DO NOTHING (Postgres/PGlite).
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

try { require("dotenv").config(); } catch { /* optional */ }

const TABLES = ["mods", "mod_classes", "mod_tags", "doc_entries", "primers"];

function detectBackend(url) {
    if (url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
    if (url.startsWith("pglite://") || url.startsWith("pglite:")) return "pglite";
    return "postgres";
}

// ── Source readers ────────────────────────────────────────────────────────────

async function readSourceSqlite(url, table) {
    const Database = require("better-sqlite3");
    const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
    const db = new Database(path, { readonly: true });
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    db.close();
    return rows;
}

async function readSourcePglite(url, table) {
    const { PGlite } = require("@electric-sql/pglite");
    const dataDir = url.replace(/^pglite:\/\//, "");
    const pg = await PGlite.create(dataDir);
    const result = await pg.query(`SELECT * FROM "${table}"`);
    await pg.close();
    return result.rows;
}

async function readSourcePostgres(url, table) {
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const result = await client.query(`SELECT * FROM "${table}"`);
    await client.end();
    return result.rows;
}

async function readFromSource(backend, url, table) {
    if (backend === "sqlite")   return readSourceSqlite(url, table);
    if (backend === "pglite")   return readSourcePglite(url, table);
    return readSourcePostgres(url, table);
}

// ── Target writers ────────────────────────────────────────────────────────────

async function writeTargetSqlite(url, table, rows) {
    const Database = require("better-sqlite3");
    const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
    const db = new Database(path);
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => "?").join(", ");
    const stmt = db.prepare(
        `INSERT OR IGNORE INTO "${table}" (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
    );
    let inserted = 0;
    let skipped = 0;
    const insertMany = db.transaction((allRows) => {
        for (const row of allRows) {
            const vals = cols.map((c) => {
                const v = row[c];
                // Postgres arrays → JSON strings for SQLite column type
                return Array.isArray(v) ? JSON.stringify(v) : v;
            });
            const info = stmt.run(...vals);
            if (info.changes > 0) inserted++; else skipped++;
        }
    });
    insertMany(rows);
    db.close();
    return { inserted, skipped };
}

async function writeTargetPg(url, table, rows, isPglite) {
    let client;
    let needsClose = false;
    if (isPglite) {
        const { PGlite } = require("@electric-sql/pglite");
        const dataDir = url.replace(/^pglite:\/\//, "");
        client = await PGlite.create(dataDir);
        needsClose = true;
    } else {
        const pg = (await import("pg")).default;
        client = new pg.Client({ connectionString: url });
        await client.connect();
        needsClose = true;
    }

    const cols = Object.keys(rows[0]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    let inserted = 0;
    let skipped = 0;

    for (const row of rows) {
        const vals = cols.map((c) => row[c]);
        try {
            const result = await client.query(sql, vals);
            if ((result.rowCount ?? 0) > 0) inserted++; else skipped++;
        } catch {
            skipped++;
        }
    }

    if (needsClose) {
        await (client.end?.() ?? client.close?.());
    }

    return { inserted, skipped };
}

// ── Migration runner ──────────────────────────────────────────────────────────

/**
 * Migrate core data from sourceUrl to targetUrl.
 * @param {string} sourceUrl
 * @param {string} targetUrl
 * @returns {Promise<number>} total rows inserted
 */
export async function migrate(sourceUrl, targetUrl) {
    const srcBackend = detectBackend(sourceUrl);
    const tgtBackend = detectBackend(targetUrl);
    console.log(`Migrating ${srcBackend} → ${tgtBackend}`);

    let total = 0;

    for (const table of TABLES) {
        process.stdout.write(`  Reading ${table}...`);
        let rows;
        try {
            rows = await readFromSource(srcBackend, sourceUrl, table);
            process.stdout.write(` ${rows.length} rows\n`);
        } catch (e) {
            process.stdout.write(` SKIP (${e.message})\n`);
            continue;
        }
        if (!rows.length) { console.log(`    ${table}: 0 rows`); continue; }

        let stats;
        try {
            if (tgtBackend === "sqlite") {
                stats = await writeTargetSqlite(targetUrl, table, rows);
            } else {
                stats = await writeTargetPg(targetUrl, table, rows, tgtBackend === "pglite");
            }
        } catch (e) {
            console.error(`    ${table}: write failed — ${e.message}`);
            continue;
        }
        console.log(`    ${table}: ${stats.inserted} inserted, ${stats.skipped} skipped`);
        total += stats.inserted;
    }

    console.log(`\nMigration complete. ${total} total rows inserted.`);
    console.log(
        "Note: mc_versions / mc_source_files were not migrated — re-run index after setup.",
    );
    return total;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("migrate-backend.mjs");
if (isCli) {
    const sourceUrl = process.env.SOURCE_DATABASE_URL ?? "";
    const targetUrl = process.env.DATABASE_URL ?? "";
    if (!sourceUrl || !targetUrl) {
        console.error("Set SOURCE_DATABASE_URL (old backend) and DATABASE_URL (new backend).");
        process.exit(1);
    }
    await migrate(sourceUrl, targetUrl);
}
