# Modpack Dev Tooling — Design Spec

**Date:** 2026-05-15
**Status:** Approved

## Problem

ModLens already has per-mod analysis tools. Modpack developers need cross-pack tooling for three distinct workflows:

1. **Before adding a mod** — "what might this break?"
2. **After it breaks** — "which mod caused this crash / what dep is missing?"
3. **Silent data clobbering** — "which mods are overwriting each other's recipes/loot/advancements?"

---

## Tool A: `check_mod_compat`

### Purpose
Pre-flight compatibility check for a candidate JAR before ingesting it into the pack.

### New File
`src/tools/compat-check.ts`

### MCP Tool Name
`check_mod_compat`

### Input
```typescript
{
  jarPath: string;          // absolute path to the candidate JAR
  mcVersion?: string;       // optional filter for comparison pool
  loader?: string;          // optional filter for comparison pool
}
```

### Logic (in order)
1. **Parse candidate** — call `parseJar(jarPath)` to extract `modId`, `version`, `dependencies`, `mixinTargets`, `atEntries`, `awEntries`, `mixinConfigs`, `loader`, `mcVersion`. Do NOT ingest.
2. **Mixin conflicts** — query existing mods in DB that share any target in `mixinTargets`. Group by target class. Any shared target with an already-ingested mod = issue.
3. **AT/AW conflicts** — compare `atEntries` and `awEntries` against all ingested mods' AT/AW entries. Flag exact class+member matches.
4. **Asset conflicts** — list all `assets/` paths in the candidate JAR. For each, check if any ingested mod also ships it (scan via `listEntries`).
5. **Dependency gaps** — for each entry in `dependencies`, check if `modId` exists in the DB. Flag missing ones. Ignore `minecraft`, `neoforge`, `fabric-api`, `forge` (loader-level deps).
6. **Sidedness** — call `analyzeModSidedness` on the candidate `jarPath`.

### Output Shape
```typescript
{
  candidate: { modId, version, loader, mcVersion };
  sidedness: { sidedness, source, evidence };
  issues: Array<{
    severity: "error" | "warn" | "info";
    type: "mixin_conflict" | "at_conflict" | "aw_conflict" | "asset_conflict" | "missing_dep" | "sidedness";
    detail: string;
    relatedMod?: string;    // which existing mod is involved
    path?: string;          // for asset/AT conflicts
  }>;
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    safe: boolean;          // true if errors === 0
  };
}
```

### Severity Rules
| Check | Severity | Rationale |
|---|---|---|
| Mixin target shared with existing mod | `error` | Runtime transformation conflict risk |
| AT class+member overlap | `error` | Silent access widening collision |
| AW class+member overlap | `error` | Same as AT for Fabric side |
| Asset path overlap | `warn` | One mod silently wins, visual regression |
| Missing dependency | `warn` | May cause startup failure |
| Sidedness `unknown` | `info` | Informational only |
| Sidedness `client_only` / `server_only` | `info` | Useful for pack trimming |

### Server Registration
Add to `src/server.ts` as a top-level tool.

---

## Tool B: `analyzeCrashLog` + `findMissingDeps`

### Purpose
- `analyzeCrashLog` — paste a crash log, get a ranked list of suspect mods.
- `findMissingDeps` — find declared dependencies not satisfied by ingested mods.

### New File
`src/tools/diagnostics.ts`

### MCP Tool Names
`analyze_crash_log`, `find_missing_deps`

---

### `analyzeCrashLog(logText)`

#### Input
```typescript
{ logText: string }
```

#### Logic
1. **Extract stack frames** — regex: `/at ([\w.$]+)\.([\w$<>]+)\(([^)]+)\)/g` on every line. Collect fully-qualified class names.
2. **Normalise** — convert `.` → `/` to match DB `className` format.
3. **Bulk DB lookup** — query `ModClass` table: `WHERE class_name = ANY($classNames)`. Returns `(class_name, mod_id)` rows. (Requires `reindexClasses` to have been run.)
4. **Rank by frame count** — for each mod, count how many stack frames match. Sort descending.
5. **Extract "Mod List" section** — NeoForge crash reports include a `-- Mod List --` block. Regex-extract all `modId|version` lines. Cross-reference with DB.
6. **Coverage warning** — if `unrecognizedClasses / totalClasses > 0.5`, warn that class index coverage is low and suggest running `reindex_classes`.

#### Output
```typescript
{
  suspects: Array<{
    modId: string;
    display: string;
    dbId: number;
    frameCount: number;
    frames: string[];       // top 5 matching class names
  }>;
  modsInLogSection: string[];    // from "-- Mod List --" if present
  totalFrames: number;
  recognizedFrames: number;
  unrecognizedFrames: number;
  coverageWarning?: string;
}
```

#### Notes
- Does NOT require the crash to be from a pack ingested into the DB — works on any NeoForge/Fabric/Forge crash log.
- Accuracy scales with `reindexClasses` coverage.

---

### `findMissingDeps(mcVersion?, loader?)`

#### Input
```typescript
{
  mcVersion?: string;
  loader?: string;
}
```

#### Logic
1. Fetch all mods from DB with their `dependencies` JSON column.
2. Collect the set of all ingested `modId` strings.
3. For each mod, parse `dependencies` (array of `{ modId, versionRange, mandatory? }` objects — format varies by loader, use best-effort parsing).
4. Skip loader-level pseudo-deps: `minecraft`, `neoforge`, `forge`, `fabric-api`, `fabricloader`, `quilt_loader`, `java`.
5. Flag any `modId` referenced in dependencies that is not in the ingested set.

#### Output
```typescript
{
  mcVersion: string;
  loader: string;
  modsChecked: number;
  missing: Array<{
    requiredBy: string;       // modId of the mod that declared the dep
    requiredByDisplay: string;
    depModId: string;
    versionRange: string;
    mandatory: boolean;
  }>;
  satisfied: number;
  unsatisfied: number;
}
```

### Server Registration
Add both as top-level tools in `src/server.ts`.

---

## Tool C: `findDataConflicts`

### Purpose
Detect when two or more mods ship the same data resource path (recipe, loot table, advancement, etc.), causing one to silently overwrite the other.

### New Location
Add `findDataConflicts` to **`src/tools/packtools.ts`** (alongside `findAssetConflicts`).

### MCP Tool
Added to the existing `pack_tools` handler in `src/server.ts` as a new `action`.

### Input
```typescript
{
  dataType?: "recipe" | "loot_tables" | "advancements" | "tags" | "structures" | "all";
  mcVersion?: string;
  loader?: string;
  limit?: number;           // default 300
}
```

### Logic
1. Build a prefix filter from `dataType`: e.g. `"recipe"` → scan paths containing `/recipe/` under `data/`.
2. For each ingested mod JAR, call `listEntries(jarPath, "data/")`.
3. Filter to paths matching the dataType prefix (or all `data/` if `"all"`).
4. Strip directory entries (paths ending in `/`).
5. Build `path → [{ modId, display }]` map — same pattern as `findAssetConflicts`.
6. Conflicts = paths with 2+ owners.
7. Tag `minecraft`-namespace paths as higher severity (vanilla data overrides).

### Output
```typescript
{
  modsScanned: number;
  totalConflicts: number;
  capped: boolean;
  byType: Record<string, number>;    // { recipe: N, loot_tables: N, ... }
  vanillaOverrideConflicts: number;  // paths under data/minecraft/
  note: string;
  conflicts: Array<{
    path: string;
    isVanillaOverride: boolean;
    modCount: number;
    mods: Array<{ mod: string; display: string }>;
  }>;
}
```

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/tools/compat-check.ts` | **Create** | `checkModCompat` tool |
| `src/tools/diagnostics.ts` | **Create** | `analyzeCrashLog`, `findMissingDeps` |
| `src/tools/packtools.ts` | **Modify** | Add `findDataConflicts` |
| `src/server.ts` | **Modify** | Register 3 new tools + new action on pack_tools |

## Implementation Order

1. Tool C (`findDataConflicts`) — smallest, follows existing pattern in packtools.ts
2. Tool B (`findMissingDeps`) — simple DB query, no new patterns
3. Tool B (`analyzeCrashLog`) — bulk ModClass lookup, most complex
4. Tool A (`checkModCompat`) — composes all of the above

## Out of Scope
- Config key collision detection (requires runtime config parsing — deferred)
- Pack export manifest generation (deferred)
- Load-order circular dep detection (deferred — complex graph analysis)
