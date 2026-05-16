# Design: Multi-Backend Profiles & Reconfigure Mode

**Date:** 2026-05-16  
**Status:** Approved — pending implementation plan  
**Scope:** `src/setup.ts`, `src/db.ts`, `src/db-backend.ts` (new), `src/search-adapter.ts` (new), `src/repositories/embeddings*.ts`, `prisma/`, `package.json`

---

## 1. Goals

1. Let users run modlens without Docker by supporting PGlite (embedded Postgres WASM) and SQLite as first-class backends.
2. Expose preset **profiles** at the top of the wizard so the common paths are one-key choices, not a maze of prompts.
3. Preserve existing data non-destructively when reconfiguring — automatic backups before any destructive change, optional migration and optional cleanup.
4. Keep the full custom picker available for power users.

---

## 2. Profiles

Six profiles shown at the top of the wizard (fresh install and reconfigure alike). Each is a named preset that sets `backend + docker + semantic` flags before any further prompts.

| # | Profile | Backend | Docker needed | Semantic | Default? |
|---|---------|---------|---------------|----------|----------|
| 1 | **Full power** | Docker Postgres | Postgres + Ollama | Docker Ollama | ✅ recommended |
| 2 | **Zero-friction** | PGlite (embedded) | None (Ollama optional) | Local/remote Ollama | |
| 3 | **Lightweight** | SQLite + sqlite-vec | None | Local/remote Ollama | |
| 4 | **Standard** | Docker Postgres | Postgres only | None | |
| 5 | **Existing server** | User-supplied URL | None | Remote Ollama optional | |
| 6 | **Custom** | Fine-grained picks | Depends | Depends | |

Profile descriptions shown in the TUI (hint text):

- **Full power** — "Docker Postgres + Docker Ollama. Best performance, fully managed. Recommended."
- **Zero-friction** — "Embedded Postgres via PGlite. No Docker required. Local Ollama optional."
- **Lightweight** — "SQLite + sqlite-vec. Fully self-contained, zero runtime dependencies."
- **Standard** — "Docker Postgres only. Solid baseline, no semantic search."
- **Existing server** — "Connect to a Postgres/PGlite/SQLite instance you already manage."
- **Custom** — "Pick every option manually."

---

## 3. Backend Abstraction Layer

### 3.1 Backend detection — `src/db-backend.ts` (new)

```ts
export type Backend = "postgres" | "pglite" | "sqlite";

export function detectBackend(): Backend {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
  if (url.startsWith("pglite://") || url.startsWith("pglite:"))  return "pglite";
  return "postgres";
}
```

This is the single runtime signal — the shape of `DATABASE_URL`.

### 3.2 DATABASE_URL conventions

| Backend | URL format |
|---------|-----------|
| Docker Postgres | `postgresql://modlens:modlens@localhost:5433/modlens` |
| PGlite | `pglite:///home/you/.modlens-data` (path to data directory) |
| SQLite | `file:/home/you/.modlens-data/modlens.db` |

### 3.3 Prisma schemas

```
prisma/
  schema.prisma                   ← unchanged — postgresql provider (Postgres + PGlite)
  backends/
    schema.sqlite.prisma          ← new — sqlite provider, same models, FTS5 virtual tables
```

PGlite uses the existing `schema.prisma` because it exposes a Postgres-compatible socket via `@electric-sql/pglite/node`. No schema changes needed for PGlite.

SQLite schema differences:
- Provider: `sqlite`
- FTS5 virtual tables added for doc_entries, primers, mc_source_files (raw SQL migration, not Prisma models)
- Vector columns: `embedding BLOB` (sqlite-vec stores as raw float32 blobs)

### 3.4 Prisma client init — `src/db.ts` changes

```ts
import { detectBackend } from "./db-backend.js";
import { PrismaClient } from "@prisma/client";          // postgres/pglite build
// sqlite client imported conditionally from a second generate output

// Initialization is async — modules call getDb() rather than
// importing a top-level PrismaClient instance directly.
export async function createClient(): Promise<PrismaClient> {
  const backend = detectBackend();
  if (backend === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { PrismaPGlite } = await import("@prisma/adapter-pglite");
    const dataDir = process.env.DATABASE_URL!.replace("pglite://", "");
    const pg = new PGlite(dataDir);
    const adapter = new PrismaPGlite(pg);
    return new PrismaClient({ adapter });
  }
  if (backend === "sqlite") {
    // Uses separate generated client from schema.sqlite.prisma output dir
    const { PrismaClient: SQLiteClient } = await import("./generated/sqlite/index.js");
    return new SQLiteClient() as unknown as PrismaClient;
  }
  return new PrismaClient(); // postgres default
}

// Singleton — callers: `const db = await getDb()`
let _client: PrismaClient | null = null;
export async function getDb(): Promise<PrismaClient> {
  if (!_client) _client = await createClient();
  return _client;
}
```

The rest of the codebase switches from direct `import { db }` to `await getDb()`. Tools need no other changes.

### 3.5 FTS search adapter — `src/search-adapter.ts` (new)

Unified interface so tool files never write raw FTS SQL:

```ts
export interface FtsResult { id: string; rank: number }

export async function ftsSearchDocs(query: string, limit: number): Promise<FtsResult[]>
export async function ftsSearchPrimers(query: string, limit: number): Promise<FtsResult[]>
export async function ftsSearchSource(query: string, version: string, limit: number): Promise<FtsResult[]>
```

Internally: detects backend via `detectBackend()`, dispatches to:
- Postgres/PGlite path: existing `to_tsvector / plainto_tsquery` queries (unchanged)
- SQLite path: `FTS5 MATCH` queries against the virtual tables

Tool files (`docs.ts`, `primers.ts`, `mc-fts.ts`) call the adapter functions. The existing direct Prisma `$queryRaw` calls in those tools are replaced with adapter calls.

### 3.6 Vector / embeddings adapter

```
src/repositories/
  embeddings.ts          ← existing — pgvector path (postgres + pglite)
  embeddings-sqlite.ts   ← new — sqlite-vec path, identical exported signatures
```

Factory in `src/repositories/index.ts` (new):
```ts
export function getEmbeddingsRepo() {
  return detectBackend() === "sqlite"
    ? import("./embeddings-sqlite.js")
    : import("./embeddings.js");
}
```

Tools import from the factory, not directly from `embeddings.ts`.

---

## 4. Wizard Flow

### 4.1 Fresh install

```
◆ modlens setup

◆ Choose a setup profile
  ◉ Full power      — Docker Postgres + Docker Ollama + semantic search  (recommended)
  ○ Zero-friction   — PGlite embedded DB, no Docker required
  ○ Lightweight     — SQLite, fully self-contained
  ○ Standard        — Docker Postgres, no semantic search
  ○ Existing server — Connect to my own instance
  ○ Custom          — Pick every option manually

[profile-specific follow-up questions — see §4.2]

◆ Seed default docs and primers?  › Yes / No
◆ Embed docs/primers for semantic search?  › Yes / No   [only if semantic enabled]
◆ Configure MCP client?  › VS Code / Claude Desktop / Snippet / Skip

◇ Done! ...
```

### 4.2 Profile-specific follow-up questions

**Full power:**
1. Docker check (hard exit if not running)
2. Embedding model picker (nomic-embed-text / mxbai-embed-large / custom)
3. → Start `docker compose --profile semantic up -d`
4. → Wait for Postgres + Ollama → pull model
5. → Write `.env` with `postgresql://...` + `OLLAMA_*`
6. → `prisma db push` (postgres schema)
7. → `npm run db:vector` (pgvector extension + columns)

**Zero-friction:**
1. Data directory prompt — default `~/.modlens-data/`, offer `./data/` or custom path
2. Docker check (soft — only needed for Ollama; if Docker absent, Ollama options skip to local/remote/none)
3. Semantic search: None / Local Ollama / Remote Ollama
4. If semantic: embedding model picker + Ollama URL
5. → Write `.env` with `pglite:///path` + optional `OLLAMA_*`
6. → PGlite init (creates data dir, runs schema via Prisma PGlite adapter)
7. → pgvector extension init (PGlite supports pgvector natively)

**Lightweight:**
1. Data directory prompt — default `~/.modlens-data/modlens.db`, offer `./data/modlens.db` or custom
2. Semantic search: None / Local Ollama / Remote Ollama
3. If semantic: embedding model picker + Ollama URL
4. → Write `.env` with `file:///path/modlens.db` + optional `OLLAMA_*`
5. → `prisma db push --schema prisma/backends/schema.sqlite.prisma`
6. → Create FTS5 virtual tables (raw SQL, separate migration script)
7. → `npm run db:vector:sqlite` (sqlite-vec extension load + blob columns)

**Standard:**
1. Docker check (hard exit)
2. → Start `docker compose up -d`
3. → Write `.env` with `postgresql://...`
4. → `prisma db push`

**Existing server:**
1. URL prompt (prefilled from current `.env` if present)
2. Backend auto-detected from URL shape → confirms detected type
3. Semantic: None / Ollama URL
4. → Write `.env`
5. → `prisma db push` (schema selected by detected backend)
6. → `db:vector` or `db:vector:sqlite` if semantic enabled

**Custom:**
- Current fine-grained picker, unchanged
- Sections filtered to only show options valid for selected backend (e.g. pgvector section hidden for SQLite, Docker sections hidden for PGlite/SQLite)

### 4.3 Reconfigure (`.env` already exists)

```
◆ modlens — reconfigure

Current config:
  Profile:            Full power
  Backend:            postgresql://modlens:modlens@localhost:5433/modlens
  Semantic:           http://localhost:11434 / nomic-embed-text

◆ What would you like to do?
  ◉ Full wizard  — re-run all steps (idempotent, good for upgrades)
  ○ Pick tasks   — choose which steps to run
  ○ Switch profile — change backend or semantic config
```

If **Switch profile** selected:
1. Show profile picker (same as fresh install, pre-selects current profile)
2. If new profile has a **different backend** than current:
   - Show warning: "Switching from Postgres to PGlite will change your database backend."
   - **Backup step runs automatically** (see §5) before any data changes
   - Offer migration: "Migrate existing data to the new backend?" (default: Yes)
   - Proceed with new profile's follow-up questions

---

## 5. Non-Destructive Reconfigure & Backup

### 5.1 When backups are created

A backup is created automatically, before any modification, whenever:
- The backend type changes (e.g. Postgres → PGlite, PGlite → SQLite)
- Docker containers are stopped or removed
- The data directory path changes (PGlite/SQLite)
- A schema migration runs on an existing database (full wizard re-run on a populated DB)

### 5.2 Backup mechanics by backend

| Backend | Backup method | Output |
|---------|--------------|--------|
| Docker Postgres | `pg_dump` via `docker exec` | `~/.modlens-backups/modlens-postgres-<timestamp>.sql` |
| PGlite | `cp -r <dataDir>` | `~/.modlens-backups/modlens-pglite-<timestamp>/` |
| SQLite | `cp <db file>` | `~/.modlens-backups/modlens-sqlite-<timestamp>.db` |

Backup directory: `~/.modlens-backups/` (not inside the repo, not git-tracked). Configurable via `MODLENS_BACKUP_DIR` env var.

The wizard shows the backup path and confirms before proceeding:
```
◇ Backup created: ~/.modlens-backups/modlens-postgres-20260516T143022.sql
  To restore: psql postgresql://modlens:modlens@localhost:5433/modlens < <file>
```

### 5.3 Migration offer

After backup, if switching backends:
```
◆ Migrate existing data to the new backend?
  ◉ Yes — import mods, docs, primers from backup into new DB
  ○ No  — start with an empty database on the new backend
```

Migration is best-effort: standard `INSERT` statements extracted from the dump, re-executed against the new backend. Decompiled source files are not migrated (too large — user re-decompiles). The wizard reports what was migrated and any failures.

### 5.4 Cleanup offer (only after successful migration)

```
◆ Remove old backend data?
  ○ Yes — delete Docker volume / old data directory / old .db file
  ◉ No  — keep old data (default, safe)
```

Default is always **No**. Cleanup is one extra explicit confirmation step, not automatic.

### 5.5 Restore instructions

After any backup, the wizard logs restore instructions:
- Postgres: `psql <url> < <file>`
- PGlite: `cp -r <backup dir> <data dir>`
- SQLite: `cp <backup file> <db path>`

These are also written to `~/.modlens-backups/README.md` (append-only log of all backups + their restore commands).

---

## 6. New npm Scripts

| Script | What it does |
|--------|-------------|
| `npm run setup` | Build + run setup wizard (existing, now with profiles) |
| `npm run db:push` | `prisma db push` — auto-selects schema by `DATABASE_URL` |
| `npm run db:push:sqlite` | `prisma db push --schema prisma/backends/schema.sqlite.prisma` |
| `npm run db:vector` | Existing — pgvector for Postgres/PGlite |
| `npm run db:vector:sqlite` | New — sqlite-vec FTS5 tables + blob columns |
| `npm run db:generate` | `prisma generate` for active backend |
| `npm run db:backup` | Manual backup trigger (same logic as wizard) |

---

## 7. New Dependencies

| Package | Used for | Backend |
|---------|----------|---------|
| `@electric-sql/pglite` | Embedded Postgres WASM engine | PGlite |
| `@prisma/adapter-pglite` | Prisma driver adapter for PGlite | PGlite |
| `better-sqlite3` | SQLite native binding | SQLite |
| `sqlite-vec` | Vector ANN search extension for SQLite | SQLite |
| `@types/better-sqlite3` | Types | SQLite |

All new deps go into `optionalDependencies` in `package.json`. They are downloaded on `npm install` but a native binding failure (e.g. `better-sqlite3` on an unusual platform) will not block install. The wizard verifies each dep is loadable via a try/import check and surfaces a clear error if one is missing, rather than running `npm install` at runtime.

---

## 8. File Diff Summary

**New files:**
- `src/db-backend.ts` — backend detection
- `src/search-adapter.ts` — unified FTS interface
- `src/repositories/embeddings-sqlite.ts` — sqlite-vec embeddings
- `src/repositories/index.ts` — embeddings factory
- `prisma/backends/schema.sqlite.prisma` — SQLite Prisma schema
- `scripts/enable-sqlite-vec.mjs` — sqlite-vec extension + FTS5 + blob columns
- `scripts/backup.mjs` — backup logic (shared between wizard and `db:backup` script)
- `scripts/migrate-backend.mjs` — cross-backend data migration

**Modified files:**
- `src/db.ts` — backend-aware client init
- `src/setup.ts` — profiles, reconfigure flow, backup/migration steps
- `src/tools/docs.ts` — FTS calls → `ftsSearchDocs()` from search-adapter
- `src/tools/primers.ts` — FTS calls → `ftsSearchPrimers()`
- `src/tools/mc-fts.ts` — FTS calls → `ftsSearchSource()`
- `src/tools/docs.ts`, `primers.ts` — embeddings import → factory
- `package.json` — new scripts + optional deps note
- `.env.example` — document all three URL formats + `MODLENS_BACKUP_DIR`

---

## 9. Out of Scope

- Postgres → SQLite automatic schema translation (migration is INSERT-level only, not DDL)
- Multi-writer PGlite (single-process access only, as per PGlite constraints)
- Remote PGlite (PGlite is local-only by design)
- Automatic decompiled-source migration across backends (user re-decompiles)

---

## 10. Open Questions (resolved during design session)

| Question | Decision |
|----------|----------|
| PGlite data dir default | `~/.modlens-data/`, also offer `./data/` or custom |
| SQLite schema location | `prisma/backends/schema.sqlite.prisma` |
| Default profile | Full power |
| SQLite in profile list | Yes — Lightweight profile |
| Maintenance cost of dual FTS | Accepted, isolated behind search-adapter |
| Backup default | Always create before destructive change, keep old data by default |
| Migration default | Offer after backup, default Yes |
| Cleanup default | Offer after migration, default No |
