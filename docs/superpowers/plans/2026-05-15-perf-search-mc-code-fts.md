# Performance: Route searchMcCode Through FTS Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `searchMcCode` in `src/tools/vanilla.ts` currently walks every `.java` file on disk for every call — O(total decompiled source lines). The project already has `src/tools/mc-fts.ts` with `indexMcVersion` that builds a PostgreSQL FTS (`tsvector`) index over decompiled MC source. `searchMcIndexed` already uses this index. The fix is: when the FTS index exists for a version, route `searchMcCode` through `searchMcIndexed`; fall back to the filesystem walk only when the index hasn't been built yet.

**Files to modify:** `src/tools/vanilla.ts`, `src/tools/mc-fts.ts` (expose a query fn), `src/repositories/mc-source.ts` or wherever the FTS query lives.

---

## Task 1: Read the existing FTS infrastructure

- [ ] **Read `src/tools/mc-fts.ts` to understand `searchMcIndexed` signature and return shape**

  Key facts to verify:
  - `searchMcIndexed(version, query, opts)` — what opts does it take?
  - Does it support regex or only plain text?
  - What does it return? (`Array<{ file, line, text }>` or something else?)

  If `searchMcIndexed` already returns `Array<{ file: string; line: number; text: string }>` — same shape as `searchMcCode` — the integration is trivial.

---

## Task 2: Add an `isMcVersionIndexed` check to mc-fts.ts

We need to know if the FTS index has been populated for a given MC version before routing to it.

- [ ] **Append to `src/tools/mc-fts.ts`**

  ```typescript
  /**
   * Returns true if the FTS index has been built for this MC version
   * (i.e., at least one McSourceFile row exists for this version).
   */
  export async function isMcVersionIndexed(version: string): Promise<boolean> {
      const count = await db().mcSourceFile.count({ where: { version } });
      return count > 0;
  }
  ```

- [ ] **Run type-check**

  ```powershell
  npx tsc --noEmit
  ```

---

## Task 3: Route `searchMcCode` through FTS when available

- [ ] **Edit `src/tools/vanilla.ts`**

  Add imports:
  ```typescript
  import { searchMcIndexed, isMcVersionIndexed } from "./mc-fts.js";
  ```

  At the top of `searchMcCode`, after the decompile-status check, add:
  ```typescript
  // ── Fast path: use FTS index if available ────────────────────────────────
  const indexed = await isMcVersionIndexed(version);
  if (indexed && !isRegex) {
      // FTS index only supports plain-text queries, not regexes.
      // For regex searches, fall through to the filesystem walk below.
      const ftsResults = await searchMcIndexed(version, query, { limit });
      // searchMcIndexed returns the same shape: Array<{ file, line, text }>
      return ftsResults;
  }
  ```

  The rest of the function (filesystem walk) remains as-is and acts as the fallback for:
  - Regex searches (FTS doesn't support arbitrary regex)
  - Versions where `indexMcVersion` hasn't been run yet

- [ ] **Run type-check and full tests**

  ```powershell
  npx tsc --noEmit
  npm test
  ```
  Expected: clean.

- [ ] **Commit**

  ```powershell
  git add src/tools/mc-fts.ts src/tools/vanilla.ts
  git commit -m "perf: route searchMcCode through PostgreSQL FTS when index exists"
  ```

---

## Task 4: Add `searchType` awareness to FTS path

`searchMcCode` has a `searchType` parameter (`class` | `method` | `field` | `content` | `all`) that scopes the search to specific code patterns. The FTS fast path currently ignores `searchType`. If `searchMcIndexed` supports a `searchType`-like filter, thread it through. Otherwise, document the limitation.

- [ ] **Check `searchMcIndexed` signature for a type filter option**

  If it supports a type filter:
  ```typescript
  const ftsResults = await searchMcIndexed(version, query, { limit, searchType });
  ```

  If it does not (plain text only):
  ```typescript
  // For searchType ≠ "content"/"all", FTS results may include false positives.
  // Acceptable: callers already filter by context in most use-cases.
  // TODO: add searchType pre-filter to McSourceFile query.
  ```

- [ ] **Run full tests and commit**

  ```powershell
  npm test
  git add src/tools/vanilla.ts src/tools/mc-fts.ts
  git commit -m "perf: thread searchType hint into FTS path for searchMcCode"
  ```
