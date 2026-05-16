# Platform Lookup — Adapter Registry at the Ingest Seam

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded `if (sha512) / if (murmur2)` branches in `lookupPlatforms()` with an adapter registry so adding a third platform requires no edits to ingest logic.

**Architecture:** `tools/ingest.ts` currently contains `lookupPlatforms()` which has explicit conditional branches for Modrinth (sha512) and CurseForge (murmur2). The seam is inside the function. Introduce a `PlatformAdapter` type with a `lookup(hashes) → PlatformHit | null` signature, register Modrinth and CurseForge as adapters in a list, and make `lookupPlatforms` iterate the list. Each adapter lives in its respective platform file (`modrinth.ts`, `curseforge.ts`) rather than being assembled inside ingest. This does not help the other three plans but is a standalone improvement — adding e.g. a Packwiz or GitHub Releases platform lookup in future is one new file + one registration line.

**Tech Stack:** TypeScript. No new dependencies.

**Independent of:** The other three plans. Can be executed in any order.

---

## File Map

| File | Change |
|---|---|
| `src/tools/ingest.ts` | Replace `lookupPlatforms` body with adapter iteration; import adapters |
| `src/modrinth.ts` | Export a `modrinthPlatformAdapter` satisfying `PlatformAdapter` |
| `src/curseforge.ts` | Export a `curseforgePlatformAdapter` satisfying `PlatformAdapter` |
| `src/platform-adapter.ts` | **New** — `PlatformAdapter` type + `PlatformHit` type (shared contract) |

---

### Task 1: Define the shared contract

**Files:**
- Create: `src/platform-adapter.ts`

- [ ] **Step 1: Create `src/platform-adapter.ts`** with the shared types:

```ts
/** Hashes available for a mod JAR at ingest time. */
export type JarHashes = {
    sha512:  string | null;
    murmur2: string | null;
};

/** Result from a successful platform lookup. */
export type PlatformHit =
    | { platform: "modrinth";   projectId: string; slug?: string; sourceUrl?: string | null }
    | { platform: "curseforge"; projectId: number; slug?: string; sourceUrl?: string };

/** An adapter that can identify a mod JAR on one platform. */
export type PlatformAdapter = {
    name: string;
    lookup: (hashes: JarHashes) => Promise<PlatformHit | null>;
};
```

- [ ] **Step 2: Build** — expect no errors (nothing uses this yet).
```powershell
npm run build
```

---

### Task 2: Implement adapters in their platform files

**Files:**
- Modify: `src/modrinth.ts`
- Modify: `src/curseforge.ts`

- [ ] **Step 1: Add `modrinthPlatformAdapter` to `src/modrinth.ts`**:

```ts
import type { PlatformAdapter } from "./platform-adapter.js";

export const modrinthPlatformAdapter: PlatformAdapter = {
    name: "modrinth",
    async lookup({ sha512 }) {
        if (!sha512) return null;
        const ver = await lookupBySha512(sha512).catch(() => null);
        if (!ver) return null;
        const proj = await getProject(ver.project_id).catch(() => null);
        return {
            platform: "modrinth" as const,
            projectId: ver.project_id,
            slug:      proj?.slug,
            sourceUrl: proj?.source_url,
        };
    },
};
```

- [ ] **Step 2: Add `curseforgePlatformAdapter` to `src/curseforge.ts`**:

```ts
import type { PlatformAdapter } from "./platform-adapter.js";

export const curseforgePlatformAdapter: PlatformAdapter = {
    name: "curseforge",
    async lookup({ murmur2 }) {
        if (!murmur2) return null;
        const m = parseInt(murmur2, 10);
        if (isNaN(m)) return null;
        const proj = await lookupByFingerprint(m).catch(() => null);
        if (!proj) return null;
        return {
            platform: "curseforge" as const,
            projectId: proj.id,
            slug:      proj.slug,
            sourceUrl: proj.links?.sourceUrl,
        };
    },
};
```

- [ ] **Step 3: Build**
```powershell
npm run build
```
Expected: zero errors.

---

### Task 3: Rewrite `lookupPlatforms` in `tools/ingest.ts`

**Files:**
- Modify: `src/tools/ingest.ts`

- [ ] **Step 1: Add imports** at the top of `tools/ingest.ts`:

```ts
import { modrinthPlatformAdapter } from "../modrinth.js";
import { curseforgePlatformAdapter } from "../curseforge.js";
import type { PlatformHit } from "../platform-adapter.js";
```

- [ ] **Step 2: Remove the old `PlatformHit` type definitions** from `tools/ingest.ts` (the local `MrLookupOk`, `CfLookupOk`, `PlatformHit` union — they're now in `platform-adapter.ts`).

- [ ] **Step 3: Replace the `lookupPlatforms` function body**:

Before:
```ts
async function lookupPlatforms(
    sha512: string | null,
    murmur2: string | null,
): Promise<PlatformHit[]> {
    const tasks: Promise<PlatformHit | null>[] = [];
    if (sha512) {
        tasks.push( lookupBySha512(sha512).then(...).catch(() => null) );
    }
    if (murmur2) {
        const m = parseInt(murmur2, 10);
        if (!isNaN(m)) {
            tasks.push( lookupByFingerprint(m).then(...).catch(() => null) );
        }
    }
    const results = await Promise.allSettled(tasks);
    return results
        .filter(...)
        .map(...)
        .filter(...);
}
```

After:
```ts
const PLATFORM_ADAPTERS = [
    modrinthPlatformAdapter,
    curseforgePlatformAdapter,
];

async function lookupPlatforms(
    sha512: string | null,
    murmur2: string | null,
): Promise<PlatformHit[]> {
    const hashes = { sha512, murmur2 };
    const results = await Promise.allSettled(
        PLATFORM_ADAPTERS.map(a => a.lookup(hashes))
    );
    return results
        .filter((r): r is PromiseFulfilledResult<PlatformHit | null> => r.status === "fulfilled")
        .map(r => r.value)
        .filter((v): v is PlatformHit => v !== null);
}
```

- [ ] **Step 4: Remove the now-unused direct imports** of `lookupBySha512`, `getMrProject`, and `lookupByFingerprint` from `tools/ingest.ts` (the adapters own those calls now).

- [ ] **Step 5: Build**
```powershell
npm run build
```
Expected: zero errors.

- [ ] **Step 6: Commit and push**
```powershell
git add src/platform-adapter.ts src/modrinth.ts src/curseforge.ts src/tools/ingest.ts
git commit -m "refactor: platform lookup adapter registry — adding a platform is one file + one registration"
git push
```

---

### Task 4: Verify

- [ ] **Step 1: Confirm the seam is real — two adapters registered**
```powershell
Select-String -Path src/tools/ingest.ts -Pattern 'PLATFORM_ADAPTERS'
```
Expected: the constant definition with both adapters listed.

- [ ] **Step 2: Confirm the old imports are gone from `tools/ingest.ts`**
```powershell
Select-String -Path src/tools/ingest.ts -Pattern 'lookupBySha512|lookupByFingerprint|getMrProject'
```
Expected: zero results.

- [ ] **Step 3: Spot-check — ingest a mod and confirm platform IDs are populated**

Use the MCP tool: `mod action=ingest jarPath=<any JAR in the cache>`. The returned mod object should still have `modrinthId` or `curseforgeId` populated as before.
