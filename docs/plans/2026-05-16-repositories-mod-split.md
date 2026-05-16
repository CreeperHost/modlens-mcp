# repositories/mod.ts — Extract Business Logic to Tools Layer

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all non-data-access logic out of `repositories/mod.ts` so it becomes a pure data-access layer.

**Architecture:** Three functions in `repositories/mod.ts` contain business logic that belongs in the tools layer: `getMixinConflictRaw` (used only by `tools/mixin-scan.ts`), `findModsWithMixinTargetsMatching` (used only by `tools/compat-check.ts` or similar), and `findVersionConflicts` / `getDependencyGraph` which already live correctly in `tools/catalog.ts` but still import helper queries from the repo. The plan is surgical: move the two raw-SQL aggregation functions up into their respective tool files, keeping them as internal helpers rather than exported repository functions.

**Tech Stack:** TypeScript, Prisma, PostgreSQL/PGlite/SQLite via `getDb()`.

---

## File Map

| File | Change |
|---|---|
| `src/repositories/mod.ts` | Remove `getMixinConflictRaw`, `findModsWithMixinTargetsMatching` |
| `src/tools/mixin-scan.ts` | Absorb `getMixinConflictRaw` as a private function |
| `src/tools/mixins.ts` | Absorb `findModsWithMixinTargetsMatching` as a private function (used by compat check) |

---

### Task 1: Audit all callers of the two SQL functions

**Files:**
- Read: `src/repositories/mod.ts`
- Read: `src/tools/mixin-scan.ts`
- Read: `src/tools/mixins.ts`
- Search: entire `src/` for all imports of `getMixinConflictRaw` and `findModsWithMixinTargetsMatching`

- [ ] **Step 1: Find every import of the two functions**

```powershell
Select-String -Path src/**/*.ts -Pattern "getMixinConflictRaw|findModsWithMixinTargetsMatching" -Recurse
```

Expected: `getMixinConflictRaw` imported only in `tools/mixin-scan.ts`. `findModsWithMixinTargetsMatching` imported in one or two tool files.

- [ ] **Step 2: Note each caller file** — these are the only files that will need their imports updated.

---

### Task 2: Move `getMixinConflictRaw` into `tools/mixin-scan.ts`

**Files:**
- Modify: `src/tools/mixin-scan.ts`
- Modify: `src/repositories/mod.ts`

- [ ] **Step 1: Copy the full `getMixinConflictRaw` function body** from `repositories/mod.ts` into `tools/mixin-scan.ts` as a **non-exported** (private) `async function mixinConflictRaw(...)`.

The function needs `getDb` — add this import to `mixin-scan.ts`:
```ts
import { getDb } from "../db.js";
```

- [ ] **Step 2: Update `getMixinConflictMatrix` in `mixin-scan.ts`** to call the local `mixinConflictRaw(...)` instead of the imported `getMixinConflictRaw(...)`.

- [ ] **Step 3: Remove the `getMixinConflictRaw` import** from `mixin-scan.ts`'s import of `repositories/mod.ts`.

- [ ] **Step 4: Delete `getMixinConflictRaw` from `repositories/mod.ts`.**

- [ ] **Step 5: Build**
```powershell
npm run build
```
Expected: zero errors.

- [ ] **Step 5: Commit**
```powershell
git add src/tools/mixin-scan.ts src/repositories/mod.ts
git commit -m "refactor: move getMixinConflictRaw into tools/mixin-scan (data layer cleanup)"
```

---

### Task 3: Move `findModsWithMixinTargetsMatching` to its caller

**Files:**
- Modify: `src/tools/mixins.ts` (or whichever tool imports it — verify in Task 1)
- Modify: `src/repositories/mod.ts`

- [ ] **Step 1: Copy the full `findModsWithMixinTargetsMatching` function** into the tool file that calls it, as a **non-exported** private function. Add `import { getDb } from "../db.js"` if not already present.

- [ ] **Step 2: Remove the import** of `findModsWithMixinTargetsMatching` from `repositories/mod.ts` in the caller file.

- [ ] **Step 3: Delete `findModsWithMixinTargetsMatching` from `repositories/mod.ts`.**

- [ ] **Step 4: Build**
```powershell
npm run build
```
Expected: zero errors.

- [ ] **Step 5: Commit**
```powershell
git add -A
git commit -m "refactor: move findModsWithMixinTargetsMatching to tools layer (data layer cleanup)"
```

---

### Task 4: Verify repositories/mod.ts is now pure data access

**Files:**
- Read: `src/repositories/mod.ts`

- [ ] **Step 1: Skim `repositories/mod.ts`** — every exported function should now be one of:
  - A Prisma `findUnique` / `findMany` / `findFirst` / `create` / `update` / `delete`
  - A `$queryRawUnsafe` with only filtering/aggregation — no domain logic (no `for` loops assembling conflict maps, no `byModId` grouping)

- [ ] **Step 2: If any domain logic remains**, move it by the same pattern as Tasks 2–3.

- [ ] **Step 3: Final build + push**
```powershell
npm run build
git push
```
