# P2 — SQLite Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** P1 must be complete — `getDb()`, `search-adapter.ts`, embeddings factory must all exist.

**Goal:** Wire the SQLite backend end-to-end: schema, FTS5 virtual tables, sqlite-vec embeddings, and stub implementations in the search and embeddings adapters replaced with real ones.

**Architecture:** A separate Prisma schema (`prisma/backends/schema.sqlite.prisma`) covers the same models with SQLite-compatible types (`String[]` → JSON text, `Unsupported("vector")` → `Bytes?`). FTS5 virtual tables are created by `scripts/enable-sqlite-vec.mjs`. `embeddings-sqlite.ts` uses `sqlite-vec` for ANN search. `db.ts` adds the SQLite driver branch using `better-sqlite3` via Prisma's driver adapter. The search-adapter SQLite stubs are replaced with real implementations.

**Tech Stack:** `better-sqlite3`, `sqlite-vec`, `@prisma/adapter-better-sqlite3`, Prisma SQLite, FTS5 (built into SQLite).

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `prisma/backends/schema.sqlite.prisma` | Create | SQLite-compatible Prisma schema |
| `scripts/enable-sqlite-vec.mjs` | Create | FTS5 tables + sqlite-vec extension + embedding blob columns |
| `src/repositories/embeddings-sqlite.ts` | Create | sqlite-vec ANN search, identical signatures to `embeddings.ts` |
| `src/repositories/index.ts` | Modify | Wire SQLite path in `getEmbeddingsRepo()` |
| `src/search-adapter.ts` | Modify | Replace SQLite stubs with real FTS5 implementations |
| `src/db.ts` | Modify | Add SQLite driver branch using `better-sqlite3` adapter |
| `package.json` | Modify | Add `db:push:sqlite`, `db:generate:sqlite`, `db:vector:sqlite` scripts + `optionalDependencies` |

---

### Task 1: Create `prisma/backends/schema.sqlite.prisma`

**Files:**
- Create: `prisma/backends/schema.sqlite.prisma`

SQLite differences from the main schema:
- Provider: `sqlite`
- `String[]` → `String @default("[]")` (stored as JSON text, serialized/deserialized in repositories)
- `Unsupported("vector")?` → `Bytes?` (sqlite-vec stores float32 blobs)
- `Json` fields stay as `String` (Prisma SQLite maps `Json` → `String`)
- No `mode: "insensitive"` in generated client (SQLite LIKE is case-insensitive for ASCII by default)
- Output dir set to `src/generated/sqlite/`

- [ ] **Step 1: Create the schema file**

```prisma
// prisma/backends/schema.sqlite.prisma
generator client {
  provider = "prisma-client-js"
  output   = "../../src/generated/sqlite"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Mod {
  id            Int      @id @default(autoincrement())
  modId         String   @map("mod_id")
  displayName   String   @map("display_name")
  version       String
  mcVersion     String   @map("mc_version")
  loader        String
  jarPath       String   @unique @map("jar_path")
  sha256        String?
  murmur2       String?
  sha512        String?
  sourcePath    String?  @map("source_path")
  decompPath    String?  @map("decomp_path")
  decompiled    Boolean  @default(false)
  modrinthId    String?  @map("modrinth_id")
  curseforgeId  Int?     @map("curseforge_id")
  hasMixins     Boolean  @default(false) @map("has_mixins")
  hasAt         Boolean  @default(false) @map("has_at")
  hasAw         Boolean  @default(false) @map("has_aw")
  mixinConfigs  String   @default("[]") @map("mixin_configs")
  mixinTargets  String   @default("[]") @map("mixin_targets")
  atEntries     String   @default("[]") @map("at_entries")
  awEntries     String   @default("[]") @map("aw_entries")
  dependencies  String   @default("[]")
  metadata      String   @default("{}")
  tags          String   @default("[]")
  ingestedAt    DateTime @default(now()) @map("ingested_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  classes       ModClass[]
  modTags       ModTag[]

  @@unique([modId, version, mcVersion, loader])
  @@index([modId])
  @@index([mcVersion])
  @@index([loader])
  @@index([modrinthId])
  @@index([curseforgeId])
  @@map("mods")
}

model ModClass {
  id          Int      @id @default(autoincrement())
  modId       Int      @map("mod_id")
  className   String   @map("class_name")
  superClass  String?  @map("super_class")
  interfaces  String   @default("[]")
  accessFlags Int      @default(0) @map("access_flags")

  mod         Mod      @relation(fields: [modId], references: [id], onDelete: Cascade)

  @@unique([modId, className])
  @@index([className])
  @@index([modId])
  @@map("mod_classes")
}

model McVersion {
  id          Int      @id @default(autoincrement())
  versionId   String   @unique @map("version_id")
  type        String   @default("release")
  jarPath     String?  @map("jar_path")
  decompPath  String?  @map("decomp_path")
  decompiled  Boolean  @default(false)
  indexed     Boolean  @default(false)
  releaseTime DateTime @map("release_time")
  createdAt   DateTime @default(now()) @map("created_at")

  sourceFiles McSourceFile[]

  @@map("mc_versions")
}

model ModTag {
  id        Int      @id @default(autoincrement())
  modId     Int      @map("mod_id")
  mod       Mod      @relation(fields: [modId], references: [id], onDelete: Cascade)
  registry  String
  tagPath   String   @map("tag_path")
  namespace String
  entries   String   @default("[]")
  replace   Boolean  @default(false)

  @@index([modId])
  @@index([tagPath])
  @@index([registry, tagPath])
  @@index([namespace])
  @@map("mod_tags")
}

model McSourceFile {
  id          Int      @id @default(autoincrement())
  mcVersionId Int      @map("mc_version_id")
  className   String   @map("class_name")
  content     String
  embedding   Bytes?

  mcVersion   McVersion @relation(fields: [mcVersionId], references: [id], onDelete: Cascade)

  @@unique([mcVersionId, className])
  @@index([mcVersionId])
  @@map("mc_source_files")
}

model DocEntry {
  id          Int      @id @default(autoincrement())
  className   String?  @map("class_name")
  title       String
  summary     String?
  url         String
  category    String   @default("minecraft")
  tags        String   @default("[]")
  namespace   String   @default("vanilla")
  source      String   @default("manual")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  embedding   Bytes?

  @@index([className])
  @@index([category])
  @@map("doc_entries")
}

model Primer {
  id              Int      @id @default(autoincrement())
  fromVersion     String   @map("from_version")
  toVersion       String   @map("to_version")
  fromDataVersion Int?     @map("from_data_version")
  toDataVersion   Int?     @map("to_data_version")
  modloader       String   @default("neoforge")
  title           String
  summary         String?
  url             String   @unique
  content         String?
  tags            String   @default("[]")
  source          String   @default("manual")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")
  embedding       Bytes?

  @@index([fromVersion, toVersion])
  @@index([fromDataVersion, toDataVersion])
  @@index([modloader])
  @@map("primers")
}
```

- [ ] **Step 2: Generate the SQLite client**

```bash
cd d:/Downloads/modlens-mcp
npx prisma generate --schema prisma/backends/schema.sqlite.prisma
```

Expected: `src/generated/sqlite/` created with client files.

- [ ] **Step 3: Add `src/generated/` to `.gitignore`**

```bash
# Check if already ignored
Select-String -Path ".gitignore" -Pattern "generated"
```

If not present, add:
```
src/generated/
```

- [ ] **Step 4: Commit**

```bash
git add prisma/backends/schema.sqlite.prisma .gitignore
git commit -m "feat(p2): add SQLite Prisma schema + generate client"
```

---

### Task 2: Create `scripts/enable-sqlite-vec.mjs`

**Files:**
- Create: `scripts/enable-sqlite-vec.mjs`

This script:
1. Opens the SQLite DB file from `DATABASE_URL`
2. Loads the `sqlite-vec` extension
3. Creates FTS5 virtual tables for `mc_source_files`, `doc_entries`, `primers`
4. Confirms embedding `Bytes?` columns exist (they do — schema handles this)

- [ ] **Step 1: Create the script**

```javascript
// scripts/enable-sqlite-vec.mjs
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("file:")) {
    console.error("DATABASE_URL must be a file: URL for SQLite. Got:", url);
    process.exit(1);
}

const dbPath = url.replace(/^file:\/\//, "").replace(/^file:/, "");
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
sqliteVec.load(db);

// FTS5 virtual table for mc_source_files
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mc_source_fts
    USING fts5(
        class_name,
        content,
        content='mc_source_files',
        content_rowid='id'
    );
`);

// Triggers to keep FTS table in sync
db.exec(`
    CREATE TRIGGER IF NOT EXISTS mc_source_fts_insert
    AFTER INSERT ON mc_source_files BEGIN
        INSERT INTO mc_source_fts(rowid, class_name, content)
        VALUES (new.id, new.class_name, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS mc_source_fts_delete
    AFTER DELETE ON mc_source_files BEGIN
        INSERT INTO mc_source_fts(mc_source_fts, rowid, class_name, content)
        VALUES ('delete', old.id, old.class_name, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS mc_source_fts_update
    AFTER UPDATE ON mc_source_files BEGIN
        INSERT INTO mc_source_fts(mc_source_fts, rowid, class_name, content)
        VALUES ('delete', old.id, old.class_name, old.content);
        INSERT INTO mc_source_fts(rowid, class_name, content)
        VALUES (new.id, new.class_name, new.content);
    END;
`);

// FTS5 for doc_entries
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_entries_fts
    USING fts5(
        class_name,
        title,
        summary,
        content='doc_entries',
        content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS doc_entries_fts_insert
    AFTER INSERT ON doc_entries BEGIN
        INSERT INTO doc_entries_fts(rowid, class_name, title, summary)
        VALUES (new.id, new.class_name, new.title, new.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS doc_entries_fts_delete
    AFTER DELETE ON doc_entries BEGIN
        INSERT INTO doc_entries_fts(doc_entries_fts, rowid, class_name, title, summary)
        VALUES ('delete', old.id, old.class_name, old.title, old.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS doc_entries_fts_update
    AFTER UPDATE ON doc_entries BEGIN
        INSERT INTO doc_entries_fts(doc_entries_fts, rowid, class_name, title, summary)
        VALUES ('delete', old.id, old.class_name, old.title, old.summary);
        INSERT INTO doc_entries_fts(rowid, class_name, title, summary)
        VALUES (new.id, new.class_name, new.title, new.summary);
    END;
`);

// FTS5 for primers
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS primers_fts
    USING fts5(
        title,
        summary,
        content,
        content='primers',
        content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS primers_fts_insert
    AFTER INSERT ON primers BEGIN
        INSERT INTO primers_fts(rowid, title, summary, content)
        VALUES (new.id, new.title, new.summary, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS primers_fts_delete
    AFTER DELETE ON primers BEGIN
        INSERT INTO primers_fts(primers_fts, rowid, title, summary, content)
        VALUES ('delete', old.id, old.title, old.summary, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS primers_fts_update
    AFTER UPDATE ON primers BEGIN
        INSERT INTO primers_fts(primers_fts, rowid, title, summary, content)
        VALUES ('delete', old.id, old.title, old.summary, old.content);
        INSERT INTO primers_fts(rowid, title, summary, content)
        VALUES (new.id, new.title, new.summary, new.content);
    END;
`);

// sqlite-vec virtual table for 768-dim embeddings (one per content type)
const dim = parseInt(process.env.OLLAMA_EMBED_DIM ?? "768", 10);
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_doc_entries
    USING vec0(embedding float[${dim}]);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_primers
    USING vec0(embedding float[${dim}]);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_mc_source_files
    USING vec0(embedding float[${dim}]);
`);

db.close();
console.log("sqlite-vec: FTS5 tables, triggers, and vec0 tables ready.");
```

- [ ] **Step 2: Add `db:vector:sqlite` script to `package.json`**

```json
"db:vector:sqlite": "node scripts/enable-sqlite-vec.mjs",
"db:push:sqlite": "prisma db push --schema prisma/backends/schema.sqlite.prisma",
"db:generate:sqlite": "prisma generate --schema prisma/backends/schema.sqlite.prisma"
```

- [ ] **Step 3: Add `optionalDependencies` to `package.json`**

```json
"optionalDependencies": {
    "@electric-sql/pglite": "^0.2.0",
    "@prisma/adapter-better-sqlite3": "^6.0.0",
    "@prisma/adapter-pglite": "^6.0.0",
    "better-sqlite3": "^9.0.0",
    "sqlite-vec": "^0.1.0"
}
```

And add type:
```json
"devDependencies": {
    ...existing...,
    "@types/better-sqlite3": "^7.0.0"
}
```

- [ ] **Step 4: Compile + install check**

```bash
npm install
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/enable-sqlite-vec.mjs package.json
git commit -m "feat(p2): sqlite-vec FTS5 script + optionalDependencies + db scripts"
```

---

### Task 3: Create `src/repositories/embeddings-sqlite.ts`

**Files:**
- Create: `src/repositories/embeddings-sqlite.ts`

sqlite-vec stores vectors in `vec0` virtual tables (separate from the main tables). The row ID in `vec_doc_entries` matches the `doc_entries.id`. Queries use `vec_search(vec0_table, embedding, limit)`.

- [ ] **Step 1: Create the file**

```typescript
// src/repositories/embeddings-sqlite.ts
/**
 * sqlite-vec embeddings — same exported signatures as embeddings.ts.
 * Used when DATABASE_URL is a file: path.
 *
 * sqlite-vec stores vectors in separate vec0 virtual tables.
 * Row IDs in vec0 tables match the primary table IDs.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

type VecRow = { id: number; similarity: number };

let _db: Database.Database | null = null;

function getVecDb(): Database.Database {
    if (_db) return _db;
    const url = process.env.DATABASE_URL ?? "";
    const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
    _db = new Database(path);
    sqliteVec.load(_db);
    return _db;
}

function float32Blob(vec: number[]): Buffer {
    const buf = Buffer.allocUnsafe(vec.length * 4);
    for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
    return buf;
}

// ── doc_entries ───────────────────────────────────────────────────────────────

export async function upsertDocEmbedding(id: number, vec: number[]): Promise<void> {
    const db = getVecDb();
    db.prepare(`INSERT OR REPLACE INTO vec_doc_entries(rowid, embedding) VALUES (?, ?)`).run(id, float32Blob(vec));
}

export async function searchDocsByVector(vec: number[], limit = 5): Promise<VecRow[]> {
    const db = getVecDb();
    const rows = db.prepare(`
        SELECT rowid AS id,
               vec_distance_cosine(embedding, ?) AS distance
        FROM vec_doc_entries
        ORDER BY distance
        LIMIT ?
    `).all(float32Blob(vec), limit) as Array<{ id: number; distance: number }>;
    return rows.map(r => ({ id: r.id, similarity: 1 - r.distance }));
}

// ── primers ───────────────────────────────────────────────────────────────────

export async function upsertPrimerEmbedding(id: number, vec: number[]): Promise<void> {
    const db = getVecDb();
    db.prepare(`INSERT OR REPLACE INTO vec_primers(rowid, embedding) VALUES (?, ?)`).run(id, float32Blob(vec));
}

export async function searchPrimersByVector(vec: number[], limit = 5): Promise<VecRow[]> {
    const db = getVecDb();
    const rows = db.prepare(`
        SELECT rowid AS id,
               vec_distance_cosine(embedding, ?) AS distance
        FROM vec_primers
        ORDER BY distance
        LIMIT ?
    `).all(float32Blob(vec), limit) as Array<{ id: number; distance: number }>;
    return rows.map(r => ({ id: r.id, similarity: 1 - r.distance }));
}

// ── mc_source_files ───────────────────────────────────────────────────────────

export async function upsertSourceEmbedding(id: number, vec: number[]): Promise<void> {
    const db = getVecDb();
    db.prepare(`INSERT OR REPLACE INTO vec_mc_source_files(rowid, embedding) VALUES (?, ?)`).run(id, float32Blob(vec));
}

export async function searchSourceByVector(
    vec: number[], mcVersionId: number, limit = 10,
): Promise<Array<{ id: number; class_name: string; similarity: number }>> {
    const db = getVecDb();
    const rows = db.prepare(`
        SELECT v.rowid AS id,
               s.class_name,
               vec_distance_cosine(v.embedding, ?) AS distance
        FROM vec_mc_source_files v
        JOIN mc_source_files s ON s.id = v.rowid
        WHERE s.mc_version_id = ?
        ORDER BY distance
        LIMIT ?
    `).all(float32Blob(vec), mcVersionId, limit) as Array<{ id: number; class_name: string; distance: number }>;
    return rows.map(r => ({ id: r.id, class_name: r.class_name, similarity: 1 - r.distance }));
}

export async function countUnembedded(
    table: "doc_entries" | "primers" | "mc_source_files",
    mcVersionId?: number,
): Promise<number> {
    const db = getVecDb();
    const vecTable = table === "doc_entries" ? "vec_doc_entries"
        : table === "primers" ? "vec_primers"
        : "vec_mc_source_files";

    if (table === "mc_source_files" && mcVersionId !== undefined) {
        const row = db.prepare(`
            SELECT COUNT(*) AS count
            FROM mc_source_files s
            WHERE s.mc_version_id = ?
              AND NOT EXISTS (SELECT 1 FROM ${vecTable} v WHERE v.rowid = s.id)
        `).get(mcVersionId) as { count: number };
        return row.count;
    }
    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${table} t
        WHERE NOT EXISTS (SELECT 1 FROM ${vecTable} v WHERE v.rowid = t.id)
    `).get() as { count: number };
    return row.count;
}
```

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit 2>&1 | Select-String "embeddings-sqlite"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/embeddings-sqlite.ts
git commit -m "feat(p2): add embeddings-sqlite.ts — sqlite-vec ANN search"
```

---

### Task 4: Wire SQLite into `src/repositories/index.ts`

**Files:**
- Modify: `src/repositories/index.ts`

- [ ] **Step 1: Update the factory**

```typescript
// src/repositories/index.ts
import { detectBackend } from "../db-backend.js";

export async function getEmbeddingsRepo() {
    const backend = detectBackend();
    if (backend === "sqlite") {
        return import("./embeddings-sqlite.js");
    }
    return import("./embeddings.js");
}
```

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit 2>&1 | Select-String "repositories/index"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/index.ts
git commit -m "feat(p2): wire SQLite embeddings into factory"
```

---

### Task 5: Wire SQLite FTS into `src/search-adapter.ts`

**Files:**
- Modify: `src/search-adapter.ts`

- [ ] **Step 1: Replace the three SQLite stubs with real FTS5 implementations**

For `ftsSearchSource` SQLite branch:
```typescript
if (backend === "sqlite") {
    const Database = (await import("better-sqlite3")).default;
    const path = (process.env.DATABASE_URL ?? "").replace(/^file:\/\//, "").replace(/^file:/, "");
    const db = new Database(path, { readonly: true });
    type FtsRow = { class_name: string; snippet: string };
    const rows = db.prepare(`
        SELECT s.class_name,
               snippet(mc_source_fts, 1, '', '', '...', 10) AS snippet
        FROM mc_source_fts
        JOIN mc_source_files s ON s.id = mc_source_fts.rowid
        WHERE mc_source_fts MATCH ?
          AND s.mc_version_id = ?
        ORDER BY rank
        LIMIT ?
    `).all(query, mcVersionId, limit) as FtsRow[];
    db.close();
    return rows.map(r => ({ className: r.class_name, snippet: r.snippet }));
}
```

For `ftsSearchDocs` SQLite branch:
```typescript
if (backend === "sqlite") {
    const Database = (await import("better-sqlite3")).default;
    const path = (process.env.DATABASE_URL ?? "").replace(/^file:\/\//, "").replace(/^file:/, "");
    const db = new Database(path, { readonly: true });
    type Row = { id: number; class_name: string | null; title: string; summary: string | null; url: string; category: string; namespace: string; tags: string };
    const rows = db.prepare(`
        SELECT d.id, d.class_name, d.title, d.summary, d.url, d.category, d.namespace, d.tags
        FROM doc_entries_fts
        JOIN doc_entries d ON d.id = doc_entries_fts.rowid
        WHERE doc_entries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
    `).all(query, limit) as Row[];
    db.close();
    return rows.map(r => ({
        ...r,
        tags: JSON.parse(r.tags) as string[],
        class_name: r.class_name ?? null,
    }));
}
```

For `ftsSearchPrimers` SQLite branch:
```typescript
if (backend === "sqlite") {
    const Database = (await import("better-sqlite3")).default;
    const path = (process.env.DATABASE_URL ?? "").replace(/^file:\/\//, "").replace(/^file:/, "");
    const db = new Database(path, { readonly: true });
    type Row = { id: number; title: string; summary: string | null; from_version: string; to_version: string; modloader: string | null; url: string };
    let stmt: string;
    const params: unknown[] = [query, limit];
    if (modloader) {
        stmt = `
            SELECT p.id, p.title, p.summary, p.from_version, p.to_version, p.modloader, p.url
            FROM primers_fts
            JOIN primers p ON p.id = primers_fts.rowid
            WHERE primers_fts MATCH ? AND p.modloader = ?
            ORDER BY rank LIMIT ?
        `;
        params.splice(1, 0, modloader);
    } else {
        stmt = `
            SELECT p.id, p.title, p.summary, p.from_version, p.to_version, p.modloader, p.url
            FROM primers_fts
            JOIN primers p ON p.id = primers_fts.rowid
            WHERE primers_fts MATCH ?
            ORDER BY rank LIMIT ?
        `;
    }
    const rows = db.prepare(stmt).all(...params) as Row[];
    db.close();
    return rows;
}
```

- [ ] **Step 2: Full compile check**

```bash
npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/search-adapter.ts
git commit -m "feat(p2): wire SQLite FTS5 into search-adapter"
```

---

### Task 6: Wire SQLite driver into `src/db.ts`

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Add SQLite branch to `getDb()`**

```typescript
export async function getDb(): Promise<PrismaClient> {
    if (_client) return _client;
    const backend = detectBackend();

    if (backend === "sqlite") {
        const Database = (await import("better-sqlite3")).default;
        const { PrismaLibSQL } = await import("@prisma/adapter-better-sqlite3");
        const url = process.env.DATABASE_URL ?? "";
        const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const sqlite = new Database(path);
        const adapter = new PrismaLibSQL(sqlite);
        // SQLite client generated to src/generated/sqlite/
        const { PrismaClient: SQLiteClient } = await import("./generated/sqlite/index.js");
        _client = new SQLiteClient({ adapter }) as unknown as PrismaClient;
        return _client;
    }

    if (backend === "pglite") {
        throw new Error("PGlite backend not yet supported. See P3.");
    }

    _client = new PrismaClient({
        log: process.env.DEBUG ? ["query", "error"] : ["error"],
    });
    return _client;
}
```

Note: `@prisma/adapter-better-sqlite3` is the correct adapter package (not `PrismaLibSQL` — that's for Turso's libSQL. Check current Prisma docs for the exact adapter import name).

> **Implementation note:** Verify the actual adapter package. At Prisma 6, the SQLite adapter import may be:
> ```typescript
> import { PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";
> ```
> Check: https://www.prisma.io/docs/orm/more/help-and-troubleshooting/help-articles/sqlite-better-sqlite3

- [ ] **Step 2: Full compile check**

```bash
npx tsc --noEmit 2>&1
```

Expected: no errors (the dynamic import of generated sqlite client resolves at runtime, TypeScript may warn — suppress with `// @ts-ignore` if needed on that one import).

- [ ] **Step 3: Commit + push**

```bash
git add src/db.ts
git commit -m "feat(p2): add SQLite driver branch to getDb()"
git push
```

---

### Task 7: JSON serialization for array fields

**Files:**
- Modify: `src/repositories/mod.ts`
- Modify: `src/tools/docs.ts`, `src/tools/primers.ts`

The SQLite schema stores arrays as JSON text. Any code that passes `string[]` directly to Prisma create/update for those fields needs to serialize them. The Postgres path is unaffected — use `detectBackend()` to choose serialization:

- [ ] **Step 1: Add serialization helper to `src/db-backend.ts`**

```typescript
// Add to db-backend.ts:
/**
 * Serialize a string array for storage.
 * Postgres: return as-is (native array).
 * SQLite: return JSON string.
 */
export function serializeArray(arr: string[]): string[] | string {
    return detectBackend() === "sqlite" ? JSON.stringify(arr) : arr;
}

/**
 * Deserialize a string array from storage.
 * Postgres: return as-is.
 * SQLite: parse JSON string.
 */
export function deserializeArray(val: string[] | string | null | undefined): string[] {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val as string); } catch { return []; }
}
```

- [ ] **Step 2: Apply in repositories and tools**

For every `create` / `update` / `upsert` that writes a `String[]` field (`mixinConfigs`, `tags`, `interfaces`, `entries`), wrap the array value with `serializeArray(arr)`.

For every read that reads those fields back into TypeScript code expecting `string[]`, wrap with `deserializeArray(val)`.

Focus files: `src/repositories/mod.ts` (mixin/tag fields), `src/tools/docs.ts` (`tags`), `src/tools/primers.ts` (`tags`).

- [ ] **Step 3: Compile check**

```bash
npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 4: Commit + push**

```bash
git add src/db-backend.ts src/repositories/mod.ts src/tools/docs.ts src/tools/primers.ts
git commit -m "feat(p2): array serialization helpers for SQLite JSON storage"
git push
```

---

**P2 done.** SQLite backend is fully wired: schema, FTS5, sqlite-vec, driver init, array serialization. All Postgres code is unchanged.
