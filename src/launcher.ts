#!/usr/bin/env node
/**
 * modlens-mcp launcher — entry point for npx / global installs.
 *
 * Responsibilities:
 *   1. Load ~/.modlens/.env (or local .env for git-clone users)
 *   2. If --setup flag: run the interactive setup wizard, then exit
 *   3. On first run (no .env): bootstrap a zero-config embedded SQLite database
 *      so `npx` works with no external services and no interactive setup (e.g.
 *      when launched as an MCP server over stdio), then start the server
 *   4. Check stored version against package version; if different, run
 *      profile-aware migration (post-update.mjs) and update the version sentinel
 *   5. Start the MCP server inline
 *
 * Git-clone users are unaffected — IS_INSTALLED=false skips all npx-specific
 * logic and they continue using `npm run start` / `npm run setup` as before.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Resolve paths (mirrors env-path.ts but without importing it so we can
//    load the .env before any other imports trigger DB connections) ──────────
const PKG_ROOT = join(__dirname, "..");
const IS_INSTALLED = !existsSync(join(PKG_ROOT, ".git"));

import { homedir } from "os";
const MODLENS_HOME = process.env.MODLENS_HOME ?? (IS_INSTALLED ? join(homedir(), ".modlens") : PKG_ROOT);
const ENV_FILE = IS_INSTALLED ? join(MODLENS_HOME, ".env") : join(PKG_ROOT, ".env");
const VERSION_FILE = join(MODLENS_HOME, "version");

// ── Load .env early so DB connection picks up DATABASE_URL ───────────────────
for (const ep of [ENV_FILE, join(PKG_ROOT, ".env")]) {
    if (existsSync(ep)) {
        for (const line of readFileSync(ep, "utf8").split("\n")) {
            const m = line.match(/^([^#=]+)=(.*)$/);
            if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, "");
        }
        break;
    }
}

const args = process.argv.slice(2);
const wantSetup = args.includes("--setup");
const isFirstRun = IS_INSTALLED && !existsSync(ENV_FILE);

// ── Explicit setup wizard (--setup) ─────────────────────────────────────────
// Opt-in interactive configuration (Postgres, semantic search, MCP client, …).
if (wantSetup) {
    mkdirSync(MODLENS_HOME, { recursive: true });
    const result = spawnSync(
        process.execPath,
        [join(PKG_ROOT, "dist", "setup.js")],
        {
            stdio: "inherit",
            env: { ...process.env, MODLENS_HOME },
        },
    );
    process.exit(result.status ?? 0);
}

// ── Zero-config first run: bootstrap embedded SQLite ─────────────────────────
// No interactive wizard — copy the prebuilt schema'd template database into
// ~/.modlens/data so the server can start immediately with no external services.
// Power users can switch to Postgres/semantic search any time with `--setup`.
if (isFirstRun) {
    mkdirSync(MODLENS_HOME, { recursive: true });
    const dataDir = join(MODLENS_HOME, "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "modlens.db");

    if (!existsSync(dbPath)) {
        const template = join(PKG_ROOT, "prisma", "backends", "template.db");
        if (!existsSync(template)) {
            console.error("[modlens] template.db is missing from the package — cannot bootstrap SQLite.\n[modlens] Run `npx @creeperhost/modlens-mcp --setup` to configure a database manually.");
            process.exit(1);
        }
        copyFileSync(template, dbPath);
    }

    const dbUrl = `file:${dbPath}`;
    writeFileSync(ENV_FILE, `MODLENS_PROFILE=lightweight\nDATABASE_URL=${dbUrl}\n`);
    process.env.DATABASE_URL ??= dbUrl;

    // Record the current version so the migration step below treats this fresh
    // install as already up to date (template.db already has the right schema).
    const freshVersion: string = (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { version: string }).version;
    writeFileSync(VERSION_FILE, freshVersion + "\n");

    console.error(`[modlens] First run — initialized embedded SQLite database at ${dbPath}`);
    console.error("[modlens] Run `npx @creeperhost/modlens-mcp --setup` to switch to Postgres or enable semantic search.");
}

// ── Version check + auto-migrate (installed mode only) ───────────────────────
if (IS_INSTALLED) {
    const pkgVersion: string = (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { version: string }).version;
    const storedVersion = existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, "utf8").trim() : null;

    if (storedVersion !== pkgVersion) {
        console.error(`[modlens] Version changed (${storedVersion ?? "none"} → ${pkgVersion}), running migrations...`);
        const result = spawnSync(
            process.execPath,
            [join(PKG_ROOT, "scripts", "post-update.mjs")],
            {
                stdio: "inherit",
                env: { ...process.env, MODLENS_HOME },
            },
        );
        if (result.status === 0) {
            mkdirSync(MODLENS_HOME, { recursive: true });
            writeFileSync(VERSION_FILE, pkgVersion + "\n");
        } else {
            console.error("[modlens] Migration had errors — server may not start correctly.");
        }
    }
}

// ── Start server ──────────────────────────────────────────────────────────────
// Dynamic import so all the above env-loading completes before any module
// that reads process.env at import time (e.g. db.ts) is evaluated.
await import("./server.js");
