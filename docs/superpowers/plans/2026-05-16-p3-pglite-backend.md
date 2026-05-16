# P3 — PGlite Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** P1 must be complete.

**Goal:** Wire PGlite as a zero-Docker embedded Postgres backend. PGlite uses the existing `schema.prisma` (postgresql provider) unchanged. All existing FTS queries, pgvector queries, and Prisma queries work without modification. Only `db.ts` needs a new branch.

**Architecture:** `@electric-sql/pglite` runs the full Postgres engine as WASM in-process. `@prisma/adapter-pglite` connects it to Prisma via the driver adapter API. The `DATABASE_URL` convention is `pglite:///path/to/data/dir`. `scripts/enable-pgvector.mjs` already handles pgvector setup and is reused as-is (PGlite ships pgvector natively). The `pglite://` URL prefix is detected in `db-backend.ts` and routes to the new branch.

**Tech Stack:** `@electric-sql/pglite`, `@prisma/adapter-pglite`, existing `scripts/enable-pgvector.mjs`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db.ts` | Modify | Add PGlite driver branch in `getDb()` |
| `package.json` | Modify | Add `db:push:pglite`, `db:vector:pglite` scripts |

No schema changes. No repository changes. No tool changes. That is the entire P3 scope.

---

### Task 1: Add PGlite driver branch to `src/db.ts`

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Verify PGlite adapter API**

Check the current PGlite + Prisma adapter API at: https://pglite.dev/docs/prisma

The expected import is:
```typescript
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "@prisma/adapter-pglite";
```

If the adapter package name differs in the installed version, use the correct one.

- [ ] **Step 2: Add the PGlite branch to `getDb()`**

Replace the `"pglite" throw` in `db.ts` with:

```typescript
if (backend === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { PrismaPGlite } = await import("@prisma/adapter-pglite");

    // pglite:///absolute/path  →  /absolute/path
    // pglite://relative/path   →  relative/path (relative to cwd)
    const dataDir = (process.env.DATABASE_URL ?? "")
        .replace(/^pglite:\/\//, "");

    if (!dataDir) {
        throw new Error(
            "DATABASE_URL for PGlite must be pglite:///path/to/data — data directory path is empty."
        );
    }

    // PGlite creates the directory on first run
    const pg = await PGlite.create(dataDir);
    const adapter = new PrismaPGlite(pg);
    _client = new PrismaClient({ adapter });
    return _client;
}
```

Note: `PGlite.create()` is async. Ensure the outer `getDb()` function is already `async` (it is, from P1).

Full `getDb()` after this change:
```typescript
export async function getDb(): Promise<PrismaClient> {
    if (_client) return _client;
    const backend = detectBackend();

    if (backend === "pglite") {
        const { PGlite } = await import("@electric-sql/pglite");
        const { PrismaPGlite } = await import("@prisma/adapter-pglite");
        const dataDir = (process.env.DATABASE_URL ?? "").replace(/^pglite:\/\//, "");
        if (!dataDir) throw new Error("DATABASE_URL for PGlite must be pglite:///path/to/data");
        const pg = await PGlite.create(dataDir);
        const adapter = new PrismaPGlite(pg);
        _client = new PrismaClient({ adapter });
        return _client;
    }

    if (backend === "sqlite") {
        const Database = (await import("better-sqlite3")).default;
        const { PrismaBetterSQLite3 } = await import("@prisma/adapter-better-sqlite3");
        const url = process.env.DATABASE_URL ?? "";
        const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const sqlite = new Database(path);
        const adapter = new PrismaBetterSQLite3(sqlite);
        const { PrismaClient: SQLiteClient } = await import("./generated/sqlite/index.js");
        _client = new SQLiteClient({ adapter }) as unknown as PrismaClient;
        return _client;
    }

    _client = new PrismaClient({
        log: process.env.DEBUG ? ["query", "error"] : ["error"],
    });
    return _client;
}
```

- [ ] **Step 3: Compile check**

```bash
cd d:/Downloads/modlens-mcp
npx tsc --noEmit 2>&1
```

Expected: no errors. (The PGlite imports are dynamic so TypeScript won't check them deeply without type declarations — that is fine.)

- [ ] **Step 4: Commit**

```bash
git add src/db.ts
git commit -m "feat(p3): add PGlite driver branch to getDb()"
```

---

### Task 2: Add PGlite npm scripts to `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

```json
"db:push:pglite": "prisma db push",
"db:vector:pglite": "node scripts/enable-pgvector.mjs"
```

Both scripts are identical to the Postgres equivalents — they read `DATABASE_URL` from `.env`, and Prisma's PGlite adapter handles the routing. The scripts are named separately so `setup.ts` can call them by name explicitly for the Zero-friction profile, making intent clear.

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Smoke test — PGlite round-trip**

Write a one-off test script to confirm PGlite boots correctly:

```javascript
// scripts/smoke-pglite.mjs (delete after testing)
import { PGlite } from "@electric-sql/pglite";

const pg = await PGlite.create("/tmp/modlens-pglite-smoke");
const result = await pg.query("SELECT 1 AS n");
console.log("PGlite smoke:", result.rows); // Expected: [ { n: 1 } ]
await pg.close();
console.log("PGlite OK");
```

Run:
```bash
DATABASE_URL=pglite:///tmp/modlens-pglite-smoke node scripts/smoke-pglite.mjs
```

Expected output:
```
PGlite smoke: [ { n: 1 } ]
PGlite OK
```

Delete `scripts/smoke-pglite.mjs` after confirming.

- [ ] **Step 4: Push**

```bash
git add package.json
git commit -m "feat(p3): add PGlite npm scripts (db:push:pglite, db:vector:pglite)"
git push
```

---

**P3 done.** PGlite backend fully wired in ~50 lines. All existing Postgres SQL, FTS, and pgvector queries work unchanged because PGlite runs the actual Postgres engine.
