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
import { cpSync, mkdirSync, existsSync, appendFileSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch { /* dotenv optional */ }

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const BACKUP_ROOT = process.env.MODLENS_BACKUP_DIR ?? join(homedir(), ".modlens-backups");

function detectBackend(url) {
    if (url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
    if (url.startsWith("pglite://") || url.startsWith("pglite:")) return "pglite";
    return "postgres";
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function ensureDir(dir) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function appendReadme(root, lines) {
    ensureDir(root);
    appendFileSync(join(root, "README.md"), lines.join("\n") + "\n\n");
}

// ── Postgres backup ──────────────────────────────────────────────────────────

function backupPostgres(url, root = BACKUP_ROOT) {
    ensureDir(root);
    const ts = timestamp();
    const file = join(root, `modlens-postgres-${ts}.sql`);

    try {
        execSync(`pg_dump "${url}" -f "${file}"`, { stdio: "inherit" });
    } catch {
        try {
            const container = process.env.MODLENS_POSTGRES_CONTAINER ?? "modlens-postgres";
            execSync(
                `docker exec ${container} pg_dump "${url}" > "${file}"`,
                { stdio: "inherit", shell: true },
            );
        } catch (e) {
            throw new Error(
                `pg_dump failed. Install pg_dump or ensure the postgres container is running.\n${e.message}`,
            );
        }
    }

    const restore = `psql "${url}" < "${file}"`;
    appendReadme(root, [
        `## Postgres backup — ${ts}`,
        `File: ${file}`,
        `Restore: \`${restore}\``,
    ]);
    return { file, restore };
}

// ── PGlite backup ────────────────────────────────────────────────────────────

function backupPglite(url, root = BACKUP_ROOT) {
    ensureDir(root);
    const ts = timestamp();
    const dataDir = url.replace(/^pglite:\/\//, "");
    const outDir = join(root, `modlens-pglite-${ts}`);

    if (!existsSync(dataDir)) {
        throw new Error(`PGlite data directory does not exist: ${dataDir}`);
    }

    cpSync(dataDir, outDir, { recursive: true });

    const restore = `cp -r "${outDir}" "${dataDir}"`;
    appendReadme(root, [
        `## PGlite backup — ${ts}`,
        `Directory: ${outDir}`,
        `Restore: \`${restore}\``,
    ]);
    return { dir: outDir, restore };
}

// ── SQLite backup ────────────────────────────────────────────────────────────

function backupSqlite(url, root = BACKUP_ROOT) {
    ensureDir(root);
    const ts = timestamp();
    const dbPath = url.replace(/^file:\/\//, "").replace(/^file:/, "");
    const file = join(root, `modlens-sqlite-${ts}.db`);

    if (!existsSync(dbPath)) {
        throw new Error(`SQLite database file does not exist: ${dbPath}`);
    }

    copyFileSync(dbPath, file);

    const restore = `cp "${file}" "${dbPath}"`;
    appendReadme(root, [
        `## SQLite backup — ${ts}`,
        `File: ${file}`,
        `Restore: \`${restore}\``,
    ]);
    return { file, restore };
}

// ── Programmatic API ─────────────────────────────────────────────────────────

/**
 * Backup the database at `url` to `backupRoot` (defaults to ~/.modlens-backups).
 * @param {string} url
 * @param {string} [backupRoot]
 * @returns {{ file?: string, dir?: string, restore: string }}
 */
export async function backup(url, backupRoot) {
    const root = backupRoot ?? BACKUP_ROOT;
    const backend = detectBackend(url);
    if (backend === "postgres") return backupPostgres(url, root);
    if (backend === "pglite")  return backupPglite(url, root);
    return backupSqlite(url, root);
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("backup.mjs");
if (isCli) {
    if (!DATABASE_URL) {
        console.error("DATABASE_URL is not set. Create a .env file or set the variable.");
        process.exit(1);
    }

    const backend = detectBackend(DATABASE_URL);
    console.log(`Backing up ${backend} database...`);

    const result = await backup(DATABASE_URL);
    console.log(`Backup written: ${result.file ?? result.dir}`);
    console.log(`Restore command: ${result.restore}`);
    console.log(`Restore instructions also appended to: ${join(BACKUP_ROOT, "README.md")}`);
}
