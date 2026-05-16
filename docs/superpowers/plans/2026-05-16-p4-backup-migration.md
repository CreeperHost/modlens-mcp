# P4 — Backup & Migration Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** P1 complete. P2 and P3 can be in progress simultaneously.

**Goal:** Implement non-destructive reconfigure — automatic backup before any destructive change, optional cross-backend data migration, optional cleanup of old backend data, and a `~/.modlens-backups/README.md` log of all backups with restore instructions.

**Architecture:** Two standalone ESM scripts: `scripts/backup.mjs` (backend detection + backup mechanics) and `scripts/migrate-backend.mjs` (INSERT-level cross-backend migration). Both are invoked from `setup.ts` in P5 and can also be run manually via `npm run db:backup`. They import `dotenv` to read `.env` so they work standalone.

**Tech Stack:** Node.js ESM, `better-sqlite3` (SQLite backup), `child_process` (pg_dump), filesystem copy (PGlite), `dotenv` (env loading).

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/backup.mjs` | Create | Detect backend, create timestamped backup, write restore instructions to README |
| `scripts/migrate-backend.mjs` | Create | Read from source backend, INSERT into target backend (best-effort) |
| `package.json` | Modify | Add `db:backup` script |

---

### Task 1: Create `scripts/backup.mjs`

**Files:**
- Create: `scripts/backup.mjs`

- [ ] **Step 1: Create the script**

```javascript
// scripts/backup.mjs
/**
 * Backup the active modlens database.
 * Usage: node scripts/backup.mjs
 * Or via npm: npm run db:backup
 *
 * Backs up to ~/.modlens-backups/<timestamp>-<backend>.<ext>
 * Appends restore instructions to ~/.modlens-backups/README.md
 */
import { execSync } from "child_process";
import { cpSync, mkdirSync, existsSync, appendFileSync, readFileSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { createRequire } from "module";

// Load .env if present
const require = createRequire(import.meta.url);
try {
    const dotenv = require("dotenv");
    dotenv.config();
} catch { /* dotenv optional */ }

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const BACKUP_ROOT = process.env.MODLENS_BACKUP_DIR
    ?? join(homedir(), ".modlens-backups");

function detectBackend(url) {
    if (url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
    if (url.startsWith("pglite://") || url.startsWith("pglite:"))  return "pglite";
    return "postgres";
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function ensureBackupDir() {
    if (!existsSync(BACKUP_ROOT)) mkdirSync(BACKUP_ROOT, { recursive: true });
}

function appendReadme(lines) {
    const readmePath = join(BACKUP_ROOT, "README.md");
    appendFileSync(readmePath, lines.join("\n") + "\n\n");
}

// ── Postgres backup ──────────────────────────────────────────────────────────

function backupPostgres(url) {
    ensureBackupDir();
    const ts = timestamp();
    const outFile = join(BACKUP_ROOT, `modlens-postgres-${ts}.sql`);

    try {
        execSync(`pg_dump "${url}" -f "${outFile}"`, { stdio: "inherit" });
    } catch {
        // pg_dump may not be in PATH; try via docker exec
        try {
            const container = process.env.MODLENS_POSTGRES_CONTAINER ?? "modlens-postgres";
            const pgUrl = url.replace("localhost", "127.0.0.1");
            execSync(
                `docker exec ${container} pg_dump "${pgUrl}" > "${outFile}"`,
                { stdio: "inherit", shell: true },
            );
        } catch (e) {
            throw new Error(`pg_dump failed. Install pg_dump or ensure the postgres container is running.\n${e.message}`);
        }
    }

    const restore = `psql "${url}" < "${outFile}"`;
    appendReadme([
        `## Postgres backup — ${ts}`,
        `File: ${outFile}`,
        `Restore: \`${restore}\``,
    ]);

    return { file: outFile, restore };
}

// ── PGlite backup ────────────────────────────────────────────────────────────

function backupPglite(url) {
    ensureBackupDir();
    const ts = timestamp();
    const dataDir = url.replace(/^pglite:\/\//, "");
    const outDir = join(BACKUP_ROOT, `modlens-pglite-${ts}`);

    if (!existsSync(dataDir)) {
        throw new Error(`PGlite data directory does not exist: ${dataDir}`);
    }

    cpSync(dataDir, outDir, { recursive: true });

    const restore = `cp -r "${outDir}" "${dataDir}"`;
    appendReadme([
        `## PGlite backup — ${ts}`,
        `Directory: ${outDir}`,
        `Restore: \`${restore}\``,
    ]);

    return { dir: outDir, restore };
}

// ── SQLite backup ────────────────────────────────────────────────────────────

function backupSqlite(url) {
    ensureBackupDir();
    const ts = timestamp();
    const dbPath = url.replace(/^file:\/\//, "").replace(/^file:/, "");
    const outFile = join(BACKUP_ROOT, `modlens-sqlite-${ts}.db`);

    if (!existsSync(dbPath)) {
        throw new Error(`SQLite database file does not exist: ${dbPath}`);
    }

    copyFileSync(dbPath, outFile);

    const restore = `cp "${outFile}" "${dbPath}"`;
    appendReadme([
        `## SQLite backup — ${ts}`,
        `File: ${outFile}`,
        `Restore: \`${restore}\``,
    ]);

    return { file: outFile, restore };
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set. Create a .env file or set the variable.");
    process.exit(1);
}

const backend = detectBackend(DATABASE_URL);
console.log(`Backing up ${backend} database...`);

let result;
if (backend === "postgres") {
    result = backupPostgres(DATABASE_URL);
    console.log(`Backup written: ${result.file}`);
    console.log(`Restore command: ${result.restore}`);
} else if (backend === "pglite") {
    result = backupPglite(DATABASE_URL);
    console.log(`Backup written: ${result.dir}`);
    console.log(`Restore command: ${result.restore}`);
} else {
    result = backupSqlite(DATABASE_URL);
    console.log(`Backup written: ${result.file}`);
    console.log(`Restore command: ${result.restore}`);
}

console.log(`Restore instructions also appended to: ${join(BACKUP_ROOT, "README.md")}`);
```

- [ ] **Step 2: Add `db:backup` to `package.json`**

```json
"db:backup": "node scripts/backup.mjs"
```

- [ ] **Step 3: Smoke test (requires a running Postgres from docker compose)**

```bash
# Only run if docker compose is up
npm run db:backup
```

Expected: creates a `.sql` file in `~/.modlens-backups/` and updates `README.md`.

- [ ] **Step 4: Commit**

```bash
git add scripts/backup.mjs package.json
git commit -m "feat(p4): add backup.mjs — pg_dump / cp-dir / cp-file + restore log"
```

---

### Task 2: Create `scripts/migrate-backend.mjs`

**Files:**
- Create: `scripts/migrate-backend.mjs`

This script migrates core data (mods, doc_entries, primers) from a source backend to a target backend. Decompiled MC source is intentionally excluded — too large, user re-indexes.

It uses raw SQL SELECTs on the source and raw INSERTs on the target. Both source and target connection details are passed via environment variables:

- `SOURCE_DATABASE_URL` — old backend URL
- `DATABASE_URL` — new backend URL (target)

- [ ] **Step 1: Create the script**

```javascript
// scripts/migrate-backend.mjs
/**
 * Migrate core modlens data between backends.
 *
 * Usage:
 *   SOURCE_DATABASE_URL=postgresql://... DATABASE_URL=pglite:///path node scripts/migrate-backend.mjs
 *
 * Migrates: mods, mod_classes, mod_tags, doc_entries, primers.
 * Skips:    mc_versions, mc_source_files (too large — user re-indexes).
 * Safe:     uses INSERT OR IGNORE / INSERT ... ON CONFLICT DO NOTHING.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

try { require("dotenv").config(); } catch { /* optional */ }

const SOURCE_URL = process.env.SOURCE_DATABASE_URL ?? "";
const TARGET_URL = process.env.DATABASE_URL ?? "";

if (!SOURCE_URL || !TARGET_URL) {
    console.error("Set SOURCE_DATABASE_URL (old) and DATABASE_URL (new).");
    process.exit(1);
}

function detectBackend(url) {
    if (url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
    if (url.startsWith("pglite://") || url.startsWith("pglite:"))  return "pglite";
    return "postgres";
}

const sourceBackend = detectBackend(SOURCE_URL);
const targetBackend = detectBackend(TARGET_URL);

console.log(`Migrating ${sourceBackend} → ${targetBackend}`);

// ── Source reader ─────────────────────────────────────────────────────────────
// Returns rows from the source DB for a given table.

async function readSource(table) {
    if (sourceBackend === "sqlite") {
        const Database = require("better-sqlite3");
        const path = SOURCE_URL.replace(/^file:\/\//, "").replace(/^file:/, "");
        const db = new Database(path, { readonly: true });
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        db.close();
        return rows;
    }

    if (sourceBackend === "postgres" || sourceBackend === "pglite") {
        // Use pg client for both Postgres and PGlite (PGlite supports the pg wire protocol via PGliteWorker or direct)
        // For simplicity, use pg for Postgres and @electric-sql/pglite for PGlite
        if (sourceBackend === "pglite") {
            const { PGlite } = require("@electric-sql/pglite");
            const dataDir = SOURCE_URL.replace(/^pglite:\/\//, "");
            const pg = await PGlite.create(dataDir);
            const result = await pg.query(`SELECT * FROM ${table}`);
            await pg.close();
            return result.rows;
        }
        // Postgres — use pg
        const { default: pg } = await import("pg");
        const client = new pg.Client({ connectionString: SOURCE_URL });
        await client.connect();
        const result = await client.query(`SELECT * FROM ${table}`);
        await client.end();
        return result.rows;
    }
}

// ── Target writer ─────────────────────────────────────────────────────────────

async function writeTarget(table, rows) {
    if (!rows.length) { console.log(`  ${table}: 0 rows (skipped)`); return 0; }

    const cols = Object.keys(rows[0]);
    let inserted = 0;
    let skipped = 0;

    if (targetBackend === "sqlite") {
        const Database = require("better-sqlite3");
        const path = TARGET_URL.replace(/^file:\/\//, "").replace(/^file:/, "");
        const db = new Database(path);
        const placeholders = cols.map(() => "?").join(", ");
        const stmt = db.prepare(
            `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`
        );
        const insertMany = db.transaction(rows => {
            for (const row of rows) {
                const vals = cols.map(c => {
                    const v = row[c];
                    // Postgres arrays → JSON strings for SQLite
                    return Array.isArray(v) ? JSON.stringify(v) : v;
                });
                const info = stmt.run(...vals);
                if (info.changes > 0) inserted++; else skipped++;
            }
        });
        insertMany(rows);
        db.close();
    } else if (targetBackend === "postgres" || targetBackend === "pglite") {
        const insertRow = async (client, row) => {
            const vals = cols.map(c => row[c]);
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
            try {
                if (targetBackend === "pglite") {
                    await client.query(
                        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
                        vals,
                    );
                    inserted++;
                } else {
                    await client.query(
                        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
                        vals,
                    );
                    inserted++;
                }
            } catch { skipped++; }
        };

        if (targetBackend === "pglite") {
            const { PGlite } = require("@electric-sql/pglite");
            const dataDir = TARGET_URL.replace(/^pglite:\/\//, "");
            const pg = await PGlite.create(dataDir);
            for (const row of rows) await insertRow(pg, row);
            await pg.close();
        } else {
            const { default: pg } = await import("pg");
            const client = new pg.Client({ connectionString: TARGET_URL });
            await client.connect();
            for (const row of rows) await insertRow(client, row);
            await client.end();
        }
    }

    console.log(`  ${table}: ${inserted} inserted, ${skipped} skipped (already exists)`);
    return inserted;
}

// ── Migration ─────────────────────────────────────────────────────────────────

const TABLES = ["mods", "mod_classes", "mod_tags", "doc_entries", "primers"];
let total = 0;

for (const table of TABLES) {
    process.stdout.write(`Reading ${table}...`);
    let rows;
    try {
        rows = await readSource(table);
        process.stdout.write(` ${rows.length} rows\n`);
    } catch (e) {
        console.error(`  SKIP (${e.message})`);
        continue;
    }
    total += await writeTarget(table, rows);
}

console.log(`\nMigration complete. ${total} total rows inserted.`);
console.log("Note: mc_versions / mc_source_files were not migrated — re-run index after setup.");
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrate-backend.mjs
git commit -m "feat(p4): add migrate-backend.mjs — cross-backend INSERT migration"
```

---

### Task 3: Export backup and migration as callable functions for `setup.ts`

**Files:**
- Modify: `scripts/backup.mjs`
- Modify: `scripts/migrate-backend.mjs`

The wizard in P5 needs to call backup and migration programmatically without spawning subprocesses. Export the core logic as named exports, and wrap them with an `if (process.argv[1] === ...)` guard so the scripts still work standalone.

- [ ] **Step 1: Refactor `backup.mjs` to export `backup(url, backupRoot?)`**

Add at the bottom of `backup.mjs`:
```javascript
/**
 * Programmatic entry point.
 * @param {string} url - DATABASE_URL for the backend to back up
 * @param {string} [backupRoot] - override backup directory
 * @returns {{ path: string, restore: string }}
 */
export async function backup(url, backupRoot) {
    const root = backupRoot ?? BACKUP_ROOT;
    const backend = detectBackend(url);
    if (backend === "postgres") return backupPostgres(url, root);
    if (backend === "pglite")  return backupPglite(url, root);
    return backupSqlite(url, root);
}

// Run as script if invoked directly
const isCli = process.argv[1]?.endsWith("backup.mjs");
if (isCli) {
    const { path, dir, file, restore } = await backup(DATABASE_URL);
    console.log(`Backup: ${path ?? dir ?? file}`);
    console.log(`Restore: ${restore}`);
}
```

Update the three backend functions to accept `root` as a second parameter (replace hardcoded `BACKUP_ROOT` with `root ?? BACKUP_ROOT`).

- [ ] **Step 2: Refactor `migrate-backend.mjs` to export `migrate(sourceUrl, targetUrl)`**

Add at the bottom:
```javascript
export async function migrate(sourceUrl, targetUrl) {
    // Re-run the migration logic with the given URLs
    // (extract logic into a `runMigration(src, tgt)` inner function and call it here)
}

const isCli = process.argv[1]?.endsWith("migrate-backend.mjs");
if (isCli) { await migrate(SOURCE_URL, TARGET_URL); }
```

- [ ] **Step 3: Compile check (TypeScript won't check .mjs but confirm no import errors)**

```bash
node --input-type=module --eval "import { backup } from './scripts/backup.mjs'; console.log(typeof backup);"
```

Expected: `function`

- [ ] **Step 4: Push**

```bash
git add scripts/backup.mjs scripts/migrate-backend.mjs
git commit -m "feat(p4): export backup() and migrate() for programmatic use in setup wizard"
git push
```

---

**P4 done.** `backup()` and `migrate()` are importable from `setup.ts` in P5. Both scripts also work standalone via `npm run db:backup` and direct `node` invocation.
