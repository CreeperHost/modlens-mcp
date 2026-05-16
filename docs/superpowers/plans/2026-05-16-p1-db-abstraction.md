# P1 — DB Abstraction Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synchronous `db()` singleton with an async `getDb()` factory that detects backend from `DATABASE_URL` shape, and isolate all FTS and vector queries behind adapter interfaces so tools never write backend-specific SQL.

**Architecture:** `db-backend.ts` exports `detectBackend()` and `Backend` type. `db.ts` exports async `getDb()` singleton. `search-adapter.ts` exports typed FTS functions dispatching to Postgres or SQLite paths (SQLite path is a stub for now — wired in P2). `src/repositories/index.ts` exports a `getEmbeddingsRepo()` factory (SQLite embeddings wired in P2). All call-sites updated.

**Tech Stack:** TypeScript ESM, Prisma 6, `@prisma/client`, existing `db.ts` / repository pattern.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db-backend.ts` | Create | `detectBackend()`, `Backend` type |
| `src/db.ts` | Modify | Replace `db()` with async `getDb()` singleton |
| `src/search-adapter.ts` | Create | `ftsSearchDocs`, `ftsSearchPrimers`, `ftsSearchSource` — Postgres impl, SQLite stub |
| `src/repositories/index.ts` | Create | `getEmbeddingsRepo()` factory — returns existing `embeddings.ts` (SQLite wired in P2) |
| `src/repositories/embeddings.ts` | Modify | Replace `db()` calls with `await getDb()` |
| `src/repositories/mod.ts` | Modify | Replace `db()` calls with `await getDb()` |
| `src/repositories/mcVersion.ts` | Modify | Replace `db()` calls with `await getDb()`, `searchMcSourceFiles` → `search-adapter` |
| `src/tools/docs.ts` | Modify | Replace `db()` with `await getDb()`, FTS → `ftsSearchDocs`, embeddings → factory |
| `src/tools/primers.ts` | Modify | Replace `db()` with `await getDb()`, FTS → `ftsSearchPrimers`, embeddings → factory |
| `src/tools/mc-fts.ts` | Modify | Replace `db()` with `await getDb()`, FTS → `ftsSearchSource`, embeddings → factory |
| `src/tools/compat-check.ts` | Modify | Replace `db()` with `await getDb()` |
| `src/tools/compat-check.test.ts` | Modify | Update mock for async `getDb()` |

---

### Task 1: Create `src/db-backend.ts`

**Files:**
- Create: `src/db-backend.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/db-backend.ts
/**
 * Backend detection from DATABASE_URL shape.
 * This is the single runtime signal for which DB driver to use.
 */

export type Backend = "postgres" | "pglite" | "sqlite";

export function detectBackend(): Backend {
    const url = process.env.DATABASE_URL ?? "";
    if (url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
    if (url.startsWith("pglite://") || url.startsWith("pglite:"))  return "pglite";
    return "postgres";
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd d:/Downloads/modlens-mcp
npx tsc --noEmit 2>&1 | Select-String "db-backend"
```

Expected: no output (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/db-backend.ts
git commit -m "feat(p1): add db-backend.ts — Backend type + detectBackend()"
```

---

### Task 2: Replace `db()` with async `getDb()` in `src/db.ts`

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Write the failing test** (vitest)

Create `src/db.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal smoke: getDb() returns something with .$disconnect
describe("getDb", () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.DATABASE_URL = "postgresql://modlens:modlens@localhost:5433/modlens";
    });

    it("returns a PrismaClient-shaped object", async () => {
        const { getDb } = await import("./db.js");
        const client = await getDb();
        expect(typeof client.$disconnect).toBe("function");
    });

    it("returns the same instance on repeated calls", async () => {
        const { getDb } = await import("./db.js");
        const a = await getDb();
        const b = await getDb();
        expect(a).toBe(b);
    });
});
```

- [ ] **Step 2: Run test — expect fail** (can't connect to DB, but structure should be testable with mock)

```bash
npx vitest run src/db.test.ts 2>&1 | tail -20
```

Expected: fails because `getDb` doesn't exist yet.

- [ ] **Step 3: Rewrite `src/db.ts`**

```typescript
// src/db.ts
import { PrismaClient } from "@prisma/client";
import { detectBackend } from "./db-backend.js";

let _client: PrismaClient | null = null;

/**
 * Returns the shared Prisma client, initializing it on first call.
 * For Postgres (default): standard PrismaClient.
 * For PGlite / SQLite: handled in P3 / P2 respectively — this function
 * will be extended with conditional branches in those plans.
 */
export async function getDb(): Promise<PrismaClient> {
    if (_client) return _client;
    const backend = detectBackend();
    if (backend !== "postgres") {
        throw new Error(
            `Backend "${backend}" not yet supported. Run npm run setup to configure a supported backend.`
        );
    }
    _client = new PrismaClient({
        log: process.env.DEBUG ? ["query", "error"] : ["error"],
    });
    return _client;
}

/** Legacy sync accessor — kept temporarily for the migration, removed after all call-sites updated. */
export function db(): PrismaClient {
    if (!_client) {
        _client = new PrismaClient({
            log: process.env.DEBUG ? ["query", "error"] : ["error"],
        });
    }
    return _client;
}

export async function disconnect(): Promise<void> {
    await _client?.$disconnect();
    _client = null;
}
```

Note: `db()` is kept as a bridge — it will be removed after all call-sites are updated in Tasks 4–8.

- [ ] **Step 4: Run tests**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(p1): add async getDb() to db.ts, keep legacy db() bridge"
```

---

### Task 3: Create `src/search-adapter.ts`

**Files:**
- Create: `src/search-adapter.ts`

The FTS patterns to abstract:
- `docs.ts`: Prisma `contains` with `mode: "insensitive"` (Postgres only) — on SQLite this must become raw `LIKE` (case-insensitive by default in SQLite for ASCII)
- `primers.ts`: same Prisma `contains` pattern
- `mcVersion.ts`: raw `$queryRaw` with `to_tsvector` / `plainto_tsquery` — on SQLite becomes FTS5 `MATCH`

- [ ] **Step 1: Create the file**

```typescript
// src/search-adapter.ts
/**
 * Backend-agnostic FTS adapter.
 *
 * Postgres/PGlite: uses native tsvector (mc_source_files) or
 *   case-insensitive LIKE via Prisma's mode:"insensitive".
 * SQLite: uses FTS5 MATCH (mc_source_files) or raw LIKE (docs/primers).
 *   SQLite path stubs throw until P2 wires them.
 */
import { detectBackend } from "./db-backend.js";
import { getDb } from "./db.js";

export interface FtsSourceResult {
    className: string;
    snippet: string;
}

export interface FtsDocResult {
    id: number;
    class_name: string | null;
    title: string;
    summary: string | null;
    url: string;
    category: string;
    namespace: string;
    tags: string[];
}

export interface FtsPrimerResult {
    id: number;
    title: string;
    summary: string | null;
    from_version: string;
    to_version: string;
    modloader: string | null;
    url: string;
}

// ── mc_source_files FTS ───────────────────────────────────────────────────────

export async function ftsSearchSource(
    mcVersionId: number,
    query: string,
    limit: number,
): Promise<FtsSourceResult[]> {
    const backend = detectBackend();

    if (backend === "sqlite") {
        // Wired in P2
        throw new Error("SQLite FTS for mc_source_files not yet implemented. See P2.");
    }

    // Postgres / PGlite — existing tsvector query
    const db = await getDb();
    type FtsRow = { class_name: string; snippet: string };
    const rows = await db.$queryRaw<FtsRow[]>`
        SELECT
            class_name,
            ts_headline('simple', content,
                plainto_tsquery('simple', ${query}),
                'MaxWords=25, MinWords=15, StartSel="", StopSel=""'
            ) AS snippet
        FROM mc_source_files
        WHERE mc_version_id = ${mcVersionId}
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', ${query})
        ORDER BY ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', ${query})) DESC
        LIMIT ${limit}
    `;
    return rows.map(r => ({ className: r.class_name, snippet: r.snippet }));
}

// ── doc_entries FTS ───────────────────────────────────────────────────────────

export async function ftsSearchDocs(
    query: string,
    limit = 20,
): Promise<FtsDocResult[]> {
    const backend = detectBackend();

    if (backend === "sqlite") {
        // Wired in P2
        throw new Error("SQLite FTS for doc_entries not yet implemented. See P2.");
    }

    // Postgres / PGlite — Prisma case-insensitive contains
    const db = await getDb();
    const kw = query.toLowerCase();
    type Row = { id: number; class_name: string | null; title: string; summary: string | null; url: string; category: string; namespace: string; tags: string[] };
    const rows = await db.$queryRaw<Row[]>`
        SELECT id, class_name, title, summary, url, category, namespace, tags
        FROM doc_entries
        WHERE lower(title)      LIKE ${"%" + kw + "%"}
           OR lower(summary)    LIKE ${"%" + kw + "%"}
           OR lower(class_name) LIKE ${"%" + kw + "%"}
        ORDER BY id
        LIMIT ${limit}
    `;
    return rows;
}

// ── primers FTS ───────────────────────────────────────────────────────────────

export async function ftsSearchPrimers(
    query: string,
    modloader?: string,
    limit = 20,
): Promise<FtsPrimerResult[]> {
    const backend = detectBackend();

    if (backend === "sqlite") {
        // Wired in P2
        throw new Error("SQLite FTS for primers not yet implemented. See P2.");
    }

    // Postgres / PGlite — Prisma case-insensitive contains
    const db = await getDb();
    const rows = await db.primer.findMany({
        where: {
            AND: [
                {
                    OR: [
                        { title:   { contains: query, mode: "insensitive" } },
                        { summary: { contains: query, mode: "insensitive" } },
                        { content: { contains: query, mode: "insensitive" } },
                        { tags:    { has: query } },
                    ],
                },
                ...(modloader ? [{ modloader }] : []),
            ],
        },
        select: { id: true, title: true, summary: true, fromVersion: true, toVersion: true, modloader: true, url: true },
        take: limit,
    });
    return rows.map(r => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        from_version: r.fromVersion,
        to_version: r.toVersion,
        modloader: r.modloader ?? null,
        url: r.url,
    }));
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | Select-String "search-adapter"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/search-adapter.ts
git commit -m "feat(p1): add search-adapter.ts — unified FTS interface, SQLite stubs"
```

---

### Task 4: Create `src/repositories/index.ts` — embeddings factory

**Files:**
- Create: `src/repositories/index.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/repositories/index.ts
/**
 * Factory for the embeddings repository.
 * Returns the pgvector implementation for postgres/pglite,
 * and (in P2) the sqlite-vec implementation for sqlite.
 */
import { detectBackend } from "../db-backend.js";

export async function getEmbeddingsRepo() {
    const backend = detectBackend();
    if (backend === "sqlite") {
        // Wired in P2
        throw new Error("SQLite embeddings not yet implemented. See P2.");
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
git commit -m "feat(p1): add repositories/index.ts — embeddings factory"
```

---

### Task 5: Migrate `src/repositories/embeddings.ts` to `await getDb()`

**Files:**
- Modify: `src/repositories/embeddings.ts`

- [ ] **Step 1: Replace the import and all `db()` calls**

Replace the top of the file:
```typescript
// OLD
import { db } from "../db.js";

// NEW
import { getDb } from "../db.js";
```

Then for every call to `db().$executeRawUnsafe(...)` and `db().$queryRawUnsafe(...)`, change to `(await getDb()).$executeRawUnsafe(...)` and `(await getDb()).$queryRawUnsafe(...)`.

Full updated file:
```typescript
import { getDb } from "../db.js";

type VecRow = { id: number; similarity: number };

function vecLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
}

export async function upsertDocEmbedding(id: number, vec: number[]): Promise<void> {
    const db = await getDb();
    await db.$executeRawUnsafe(
        `UPDATE doc_entries SET embedding = $1::vector WHERE id = $2`,
        vecLiteral(vec), id,
    );
}

export async function searchDocsByVector(vec: number[], limit = 5): Promise<VecRow[]> {
    const db = await getDb();
    return db.$queryRawUnsafe<VecRow[]>(
        `SELECT id, (1 - (embedding <=> $1::vector))::float AS similarity
         FROM doc_entries
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vecLiteral(vec), limit,
    );
}

export async function upsertPrimerEmbedding(id: number, vec: number[]): Promise<void> {
    const db = await getDb();
    await db.$executeRawUnsafe(
        `UPDATE primers SET embedding = $1::vector WHERE id = $2`,
        vecLiteral(vec), id,
    );
}

export async function searchPrimersByVector(vec: number[], limit = 5): Promise<VecRow[]> {
    const db = await getDb();
    return db.$queryRawUnsafe<VecRow[]>(
        `SELECT id, (1 - (embedding <=> $1::vector))::float AS similarity
         FROM primers
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vecLiteral(vec), limit,
    );
}

export async function upsertSourceEmbedding(id: number, vec: number[]): Promise<void> {
    const db = await getDb();
    await db.$executeRawUnsafe(
        `UPDATE mc_source_files SET embedding = $1::vector WHERE id = $2`,
        vecLiteral(vec), id,
    );
}

export async function searchSourceByVector(
    vec: number[], mcVersionId: number, limit = 10,
): Promise<Array<{ id: number; class_name: string; similarity: number }>> {
    const db = await getDb();
    return db.$queryRawUnsafe<Array<{ id: number; class_name: string; similarity: number }>>(
        `SELECT id, class_name, (1 - (embedding <=> $1::vector))::float AS similarity
         FROM mc_source_files
         WHERE mc_version_id = $3 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        vecLiteral(vec), limit, mcVersionId,
    );
}

export async function countUnembedded(
    table: "doc_entries" | "primers" | "mc_source_files",
    mcVersionId?: number,
): Promise<number> {
    const db = await getDb();
    if (table === "mc_source_files" && mcVersionId !== undefined) {
        const rows = await db.$queryRawUnsafe<[{ count: string }]>(
            `SELECT COUNT(*)::text AS count FROM mc_source_files WHERE mc_version_id = $1 AND embedding IS NULL`,
            mcVersionId,
        );
        return parseInt(rows[0].count, 10);
    }
    const rows = await db.$queryRawUnsafe<[{ count: string }]>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE embedding IS NULL`,
    );
    return parseInt(rows[0].count, 10);
}
```

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit 2>&1 | Select-String "embeddings"
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/embeddings.ts
git commit -m "feat(p1): migrate embeddings.ts to await getDb()"
```

---

### Task 6: Migrate `src/repositories/mod.ts` and `src/repositories/mcVersion.ts`

**Files:**
- Modify: `src/repositories/mod.ts`
- Modify: `src/repositories/mcVersion.ts`

- [ ] **Step 1: Migrate `mod.ts`**

Replace `import { db } from "../db.js"` with `import { getDb } from "../db.js"`.

Then replace every `db().` call with `(await getDb()).` — or assign at function top:
```typescript
// Pattern to apply at the top of every exported function:
const db = await getDb();
```

Run find/replace across the file: every function that currently starts with `db().something` needs `const db = await getDb();` added at the top, and `db().` becomes `db.`.

- [ ] **Step 2: Migrate `mcVersion.ts`**

Same pattern. Additionally, `searchMcSourceFiles` currently contains the raw tsvector FTS query. Replace its body with a delegation to `search-adapter.ts`:

```typescript
// src/repositories/mcVersion.ts
import { ftsSearchSource } from "../search-adapter.js";

export async function searchMcSourceFiles(
    mcVersionId: number,
    query: string,
    limit: number,
): Promise<Array<{ className: string; snippet: string }>> {
    return ftsSearchSource(mcVersionId, query, limit);
}
```

- [ ] **Step 3: Compile check**

```bash
npx tsc --noEmit 2>&1 | Select-String "mod.ts|mcVersion"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/repositories/mod.ts src/repositories/mcVersion.ts
git commit -m "feat(p1): migrate mod.ts + mcVersion.ts to await getDb(), route FTS through adapter"
```

---

### Task 7: Migrate tool files — `docs.ts`, `primers.ts`, `mc-fts.ts`, `compat-check.ts`

**Files:**
- Modify: `src/tools/docs.ts`
- Modify: `src/tools/primers.ts`
- Modify: `src/tools/mc-fts.ts`
- Modify: `src/tools/compat-check.ts`

- [ ] **Step 1: Migrate `docs.ts`**

Replace `import { db } from "../db.js"` → `import { getDb } from "../db.js"`.

Replace `import { upsertDocEmbedding, searchDocsByVector, countUnembedded } from "../repositories/embeddings.js"` → `import { getEmbeddingsRepo } from "../repositories/index.js"`.

Every function: `const db = await getDb();` at top, replace `db().` → `db.`.

The keyword fallback search in `getDocumentation()` currently does a raw `$queryRaw`. Replace with a call to `ftsSearchDocs`:

```typescript
// In getDocumentation(), replace the raw queryRaw block:
import { ftsSearchDocs } from "../search-adapter.js";
// ...
const rows = await ftsSearchDocs(keyword, 20);
return { found: rows.length > 0, query, results: rows };
```

For `semanticSearchDocumentation` and `backfillDocEmbeddings`, get the repo via factory:
```typescript
const repo = await getEmbeddingsRepo();
const rows = await repo.searchDocsByVector(vec, limit);
// etc.
```

- [ ] **Step 2: Migrate `primers.ts`**

Same pattern. The `searchPrimers` function uses Prisma `contains` with `mode: "insensitive"`. Replace with `ftsSearchPrimers`:

```typescript
import { ftsSearchPrimers } from "../search-adapter.js";

export async function searchPrimers(query, modloader, fromVersion, toVersion, limit = 20) {
    // Version filtering stays here (it's not FTS, just range queries)
    const [fromDV, toDV] = await Promise.all([...]);
    
    // Use adapter for the text search part
    const ftsResults = await ftsSearchPrimers(query, modloader, limit);
    // Filter by version range if specified (post-filter on IDs from FTS results)
    // ... existing version filter logic applied to ftsResults IDs
}
```

Note: the version filter logic can remain in `primers.ts` as a post-filter on the IDs returned by `ftsSearchPrimers`.

For embeddings, use factory same as docs.ts.

- [ ] **Step 3: Migrate `mc-fts.ts`**

Replace `db()` → `await getDb()`. The dynamic import `await import("../db.js")).db()` in the batch loop (line ~151) becomes:
```typescript
const db = await getDb();
const batch = await db.$queryRawUnsafe<...>(...)
```

For embeddings, use factory.

- [ ] **Step 4: Migrate `compat-check.ts`**

Replace `import { db }` → `import { getDb }`, add `const db = await getDb()` at top of affected functions.

- [ ] **Step 5: Full compile check**

```bash
npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/docs.ts src/tools/primers.ts src/tools/mc-fts.ts src/tools/compat-check.ts
git commit -m "feat(p1): migrate tool files to await getDb() + search-adapter + embeddings factory"
```

---

### Task 8: Update `compat-check.test.ts` mock + run tests

**Files:**
- Modify: `src/tools/compat-check.test.ts`

- [ ] **Step 1: Update mock**

The test currently mocks `db` as a sync function. Update to mock `getDb` as an async function:

```typescript
// Replace:
import { db } from "../db.js";
vi.mock("../db.js", () => ({
    db: vi.fn(() => ({ $queryRawUnsafe: vi.fn().mockResolvedValue([]) })),
}));

// With:
import { getDb } from "../db.js";
vi.mock("../db.js", () => ({
    getDb: vi.fn().mockResolvedValue({ $queryRawUnsafe: vi.fn().mockResolvedValue([]) }),
}));
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/tools/compat-check.test.ts
git commit -m "feat(p1): update compat-check test mock for async getDb()"
```

---

### Task 9: Remove legacy `db()` bridge

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Verify no remaining `db()` call-sites**

```bash
cd d:/Downloads/modlens-mcp
Select-String -Path "src/**/*.ts" -Pattern "import \{ db \}" -Recurse
```

Expected: zero matches.

- [ ] **Step 2: Remove the legacy bridge from `db.ts`**

Delete the `db()` export and its JSDoc comment. Keep only `getDb()`, `disconnect()`, and the `_client` singleton.

Final `src/db.ts`:
```typescript
import { PrismaClient } from "@prisma/client";
import { detectBackend } from "./db-backend.js";

let _client: PrismaClient | null = null;

/**
 * Returns the shared Prisma client, initializing it on first call.
 * PGlite and SQLite branches added in P3 / P2 respectively.
 */
export async function getDb(): Promise<PrismaClient> {
    if (_client) return _client;
    const backend = detectBackend();
    if (backend !== "postgres") {
        throw new Error(
            `Backend "${backend}" not yet supported. Run npm run setup to configure a supported backend.`
        );
    }
    _client = new PrismaClient({
        log: process.env.DEBUG ? ["query", "error"] : ["error"],
    });
    return _client;
}

export async function disconnect(): Promise<void> {
    await _client?.$disconnect();
    _client = null;
}
```

- [ ] **Step 3: Full compile + test**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: zero errors, all tests pass.

- [ ] **Step 4: Push**

```bash
git add src/db.ts
git commit -m "feat(p1): remove legacy db() sync bridge — all call-sites use getDb()"
git push
```

---

**P1 done.** The codebase now routes all DB access through `await getDb()`, all FTS through `search-adapter.ts`, and all vector queries through the embeddings factory. P2 (SQLite) and P3 (PGlite) can now wire their backends without touching tool code.
