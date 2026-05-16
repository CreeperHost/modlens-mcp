# Mixin Analysis — Consolidate Four Modules into One

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse mixin analysis from four scattered files into one deep module with a clear interface.

**Architecture:** Currently `tools/mixins.ts` (target resolution from bytecode/JSON), `tools/mixin-scan.ts` (conflict matrix), `repositories/mod.ts` (raw SQL aggregation — removed by the companion plan), and `tools/bytecode.ts` (JAR reading dependency) all participate in answering "what are the mixin conflicts?". After the `repositories/mod.ts` cleanup plan is applied, merge `tools/mixins.ts` into `tools/mixin-scan.ts`. The result is one file that owns the entire concept: read mixin configs from JAR, resolve targets via bytecode, store in DB, query conflicts. `tools/bytecode.ts` remains separate because it has wider responsibilities.

**Tech Stack:** TypeScript, AdmZip, `java-tools.ts` (javap), Prisma.

**Dependency:** Apply `2026-05-16-repositories-mod-split.md` first, or run in parallel on a branch — Task 2 of that plan moves `getMixinConflictRaw` into `mixin-scan.ts` which this plan then absorbs.

---

## File Map

| File | Change |
|---|---|
| `src/tools/mixin-scan.ts` | Absorb everything from `tools/mixins.ts`; becomes the single mixin-analysis module |
| `src/tools/mixins.ts` | Deleted after its exports are merged |
| `src/server.ts` | Update imports (mod_mixins tool): replace `mixins.ts` imports with `mixin-scan.ts` |
| Any other callers of `tools/mixins.ts` | Update imports |

---

### Task 1: Audit all callers of `tools/mixins.ts`

- [ ] **Step 1: Find every import of `tools/mixins.ts`**
```powershell
Select-String -Path src/**/*.ts -Pattern 'from.*tools/mixins|from.*mixins\.js' -Recurse
```

Expected callers: `server.ts` (mod_mixins tool), `mixin-scan.ts` (batch_resolve calls `resolveMixinTargets`), possibly `compat-check.ts`.

- [ ] **Step 2: List all exported functions from `tools/mixins.ts`**
```powershell
Select-String -Path src/tools/mixins.ts -Pattern '^export (async )?function'
```

Note each one — they all move into `mixin-scan.ts`.

---

### Task 2: Merge `tools/mixins.ts` into `tools/mixin-scan.ts`

**Files:**
- Modify: `src/tools/mixin-scan.ts`
- Delete: `src/tools/mixins.ts`

- [ ] **Step 1: Append the full contents of `tools/mixins.ts`** to the bottom of `tools/mixin-scan.ts`.

  Specifically move:
  - `parseMixinTargetsFromJavap()` (private helper — keep non-exported)
  - `readMixinClassesFromJar()` (private helper — keep non-exported)
  - `resolveMixinTargets()` (public — keep exported)
  - `getMixinTargets()` (public — keep exported)
  - `getMixinConflicts()` (public — keep exported)
  - `getMixinsTargetingPackage()` (public — keep exported)
  - `getAtEntries()` / `getAwEntries()` (public — keep exported)
  - `findAtAwConflicts()` (public — keep exported)

- [ ] **Step 2: Merge imports at the top of `mixin-scan.ts`** — combine the import lists from both files, deduplicating. `mixin-scan.ts` will now need `AdmZip`, `getBytecode` from `java-tools.ts`, and any other deps from `mixins.ts`.

- [ ] **Step 3: Remove the `import ... from "./mixins.js"` line** from `mixin-scan.ts` (it was importing `resolveMixinTargets` for `batchResolveMixins` — now it's local).

- [ ] **Step 4: Build**
```powershell
npm run build
```
Expected: errors only from callers that still import from `./mixins.js` — those get fixed next.

---

### Task 3: Update all callers to import from `mixin-scan.ts`

**Files:**
- Modify: `src/server.ts`
- Modify: any other file identified in Task 1

- [ ] **Step 1: In `server.ts`**, find the import block for the `mod_mixins` tool. It currently imports from both `tools/mixins.js` and `tools/mixin-scan.js`. Collapse to a single import from `tools/mixin-scan.js`.

Example — before:
```ts
import { getMixinTargets, resolveMixinTargets, getMixinConflicts, ... } from "./tools/mixins.js";
import { listModsWithMixins, getMixinConflictMatrix, ... } from "./tools/mixin-scan.js";
```

After:
```ts
import {
    getMixinTargets, resolveMixinTargets, getMixinConflicts,
    getMixinsTargetingPackage, getAtEntries, getAwEntries, findAtAwConflicts,
    listModsWithMixins, getMixinConflictMatrix, getMixinHotspots, getMixinClassDetail,
    batchResolveMixins,
} from "./tools/mixin-scan.js";
```

- [ ] **Step 2: Update any other callers** found in Task 1.

- [ ] **Step 3: Delete `src/tools/mixins.ts`**
```powershell
Remove-Item src/tools/mixins.ts
```

- [ ] **Step 4: Build**
```powershell
npm run build
```
Expected: zero errors.

- [ ] **Step 5: Commit**
```powershell
git add -A
git commit -m "refactor: merge tools/mixins into tools/mixin-scan — one module owns mixin analysis"
```

---

### Task 4: Verify the interface

- [ ] **Step 1: Skim the public exports of `tools/mixin-scan.ts`** — the module now presents one clean surface: resolve targets, query conflicts, list hotspots, batch operations. Nothing about "how bytecode is read" leaks through the interface.

- [ ] **Step 2: Confirm `tools/mixins.ts` no longer exists and no file imports from it**
```powershell
Select-String -Path src/**/*.ts -Pattern 'tools/mixins' -Recurse
```
Expected: zero results.

- [ ] **Step 3: Push**
```powershell
npm run build; git push
```
