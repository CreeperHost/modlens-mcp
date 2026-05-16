# tools/mod-data.ts — Registry-Driven Data Access

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 40+ shallow functions in `tools/mod-data.ts` with one deep module: a data-type registry plus two entry-point functions `listModData` and `getModData`.

**Architecture:** Every `listMod*` function in the file follows an identical 5-step pattern: resolve mod, build prefix from type, `listJsonEntries` with fallback namespace auto-detection, optional string filter, map to resource-location IDs. Every `getMod*` function follows: resolve mod, parse namespace/path from ID, try alternate folder spellings, return parsed JSON. Introduce a `DataTypeDescriptor` type that captures the variable parts (JAR prefix pattern, folder variants, ID extraction regex, result key name), register one descriptor per data type, and implement `listModData` / `getModData` that iterate descriptors. The 40 functions collapse to 2 entry points + a registry table. All callers (`server.ts` mod_data tool) need updating.

**Tech Stack:** TypeScript. No new dependencies.

---

## File Map

| File | Change |
|---|---|
| `src/tools/mod-data.ts` | Rewritten: registry + two deep functions replace 40 shallow ones |
| `src/server.ts` | `mod_data` tool switch cases updated to call `listModData` / `getModData` |

The existing exported functions (`listModJarFiles`, `getModJarFile`, `getModLang`, `getModSounds`) that don't fit the list/get pattern stay as-is — only the repetitive JSON registry functions get collapsed.

---

### Task 1: Catalogue the repeating pattern

**Files:**
- Read: `src/tools/mod-data.ts`
- Read: `src/server.ts` (mod_data tool section)

- [ ] **Step 1: List every `list*` / `get*` pair** and note their variable parts:

For each pair, record:
- `type` — the name callers use (e.g., `recipe`, `loot_table`, `advancement`, `blockstate`, `model`, `biome`, `structure`, `particle`, `tag`)
- `rootPrefix` — `"data"` or `"assets"`
- `subPath` — the folder inside the namespace (e.g., `recipe/`, `loot_tables/`, `worldgen/biome/`)
- `altSubPaths` — alternate spellings (e.g., `["recipe/", "recipes/"]`, `["loot_tables/", "loot_table/"]`)
- `idPattern` — the regex used to turn an entry path into a resource location string
- `resultKey` — the JSON key name in the returned object (e.g., `"recipes"`, `"lootTables"`)

- [ ] **Step 2: Identify the non-pattern functions** that must stay as-is:
  - `listModJarFiles` — generic file listing
  - `getModJarFile` — generic file read
  - `getModLang` — has custom logic (multiple lang filenames, object-to-entries)
  - `getModSounds` — returns raw JSON, no ID mapping
  - `listModDataTags` — has an extra `registry` parameter that changes the path shape
  - `getModDataTag` — same
  - Any function with recipe-chain tracing or custom parser logic

These stay exported as-is. Only the pure list/get pairs get collapsed.

---

### Task 2: Define the `DataTypeDescriptor` type and registry

**Files:**
- Modify: `src/tools/mod-data.ts`

- [ ] **Step 1: Add the descriptor type** near the top of the file (after the internal helpers):

```ts
type DataTypeDescriptor = {
    /** Canonical type name used in listModData/getModData calls */
    type: string;
    /** "data" or "assets" */
    root: "data" | "assets";
    /** Primary sub-path inside the namespace, e.g. "recipe/" */
    subPath: string;
    /** Alternate sub-paths to try if primary yields nothing */
    altSubPaths?: string[];
    /** Regex to extract [namespace, id] from a full entry path */
    idPattern: RegExp;
    /** Key name in the list result object */
    resultKey: string;
};
```

- [ ] **Step 2: Build the registry table** — one entry per collapsed list/get pair:

```ts
const DATA_TYPES: DataTypeDescriptor[] = [
    {
        type:       "recipe",
        root:       "data",
        subPath:    "recipe/",
        altSubPaths: ["recipes/"],
        idPattern:  /^data\/([^/]+)\/recipes?\/(.*?)\.json$/,
        resultKey:  "recipes",
    },
    {
        type:       "loot_table",
        root:       "data",
        subPath:    "loot_tables/",
        altSubPaths: ["loot_table/"],
        idPattern:  /^data\/([^/]+)\/loot_tables?\/(.*?)\.json$/,
        resultKey:  "lootTables",
    },
    {
        type:       "advancement",
        root:       "data",
        subPath:    "advancement/",
        altSubPaths: ["advancements/"],
        idPattern:  /^data\/([^/]+)\/advancements?\/(.*?)\.json$/,
        resultKey:  "advancements",
    },
    {
        type:       "blockstate",
        root:       "assets",
        subPath:    "blockstates/",
        idPattern:  /^assets\/([^/]+)\/blockstates\/(.*?)\.json$/,
        resultKey:  "blockstates",
    },
    {
        type:       "model",
        root:       "assets",
        subPath:    "models/",
        idPattern:  /^assets\/([^/]+)\/models\/(.*?)\.json$/,
        resultKey:  "models",
    },
    {
        type:       "biome",
        root:       "data",
        subPath:    "worldgen/biome/",
        idPattern:  /^data\/([^/]+)\/worldgen\/biome\/(.*?)\.json$/,
        resultKey:  "biomes",
    },
    {
        type:       "structure",
        root:       "data",
        subPath:    "worldgen/structure/",
        idPattern:  /^data\/([^/]+)\/worldgen\/structure\/(.*?)\.json$/,
        resultKey:  "structures",
    },
    {
        type:       "particle",
        root:       "assets",
        subPath:    "particles/",
        idPattern:  /^assets\/([^/]+)\/particles\/(.*?)\.json$/,
        resultKey:  "particles",
    },
    // Add remaining types found in Step 1 of Task 1
];
```

- [ ] **Step 3: Add a lookup helper** (used by both entry points):

```ts
function getDescriptor(type: string): DataTypeDescriptor | undefined {
    return DATA_TYPES.find(d => d.type === type);
}
```

- [ ] **Step 4: Build** — expect no errors yet since old functions still exist.

```bash
npm run build
```

---

### Task 3: Implement `listModData` and `getModData`

**Files:**
- Modify: `src/tools/mod-data.ts`

- [ ] **Step 1: Add `listModData`** after the registry:

```ts
/**
 * List all entries of a registered data type in a mod JAR.
 * type: one of the keys in DATA_TYPES (e.g. "recipe", "loot_table", "blockstate")
 * namespace: override the mod's own namespace
 * filter: substring filter on the resource location string
 */
export async function listModData(
    modId: string | number,
    type: string,
    opts?: { namespace?: string; filter?: string },
): Promise<object> {
    const descriptor = getDescriptor(type);
    if (!descriptor) return { error: `Unknown data type: "${type}". Valid types: ${DATA_TYPES.map(d => d.type).join(", ")}` };

    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const { root, subPath, altSubPaths = [], idPattern, resultKey } = descriptor;
    const ns = opts?.namespace ?? mod.modId;

    // Try primary path, then alternates, then auto-discover namespaces
    let entries = listJsonEntries(mod.jarPath, `${root}/${ns}/${subPath}`);

    for (const alt of altSubPaths) {
        if (entries.length === 0) {
            entries = listJsonEntries(mod.jarPath, `${root}/${ns}/${alt}`);
        }
    }

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, root);
        const searchPaths = [subPath, ...altSubPaths];
        for (const n of allNs) {
            for (const sp of searchPaths) {
                entries.push(...listJsonEntries(mod.jarPath, `${root}/${n}/${sp}`));
            }
        }
    }

    if (opts?.filter) {
        const f = opts.filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(idPattern);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, type, count: ids.length, [resultKey]: ids };
}
```

- [ ] **Step 2: Add `getModData`**:

```ts
/**
 * Get a single data entry by resource location from a mod JAR.
 * type: one of the keys in DATA_TYPES
 * id: resource location string, e.g. "mymod:iron_sword" or plain "iron_sword"
 */
export async function getModData(
    modId: string | number,
    type: string,
    id: string,
    opts?: { namespace?: string },
): Promise<object> {
    const descriptor = getDescriptor(type);
    if (!descriptor) return { error: `Unknown data type: "${type}". Valid types: ${DATA_TYPES.map(d => d.type).join(", ")}` };

    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const { root, subPath, altSubPaths = [] } = descriptor;
    const ns = opts?.namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    for (const sp of [subPath, ...altSubPaths]) {
        const data = readJson(mod.jarPath, `${root}/${ns}/${sp}${path}.json`);
        if (data) return { mod: mod.modId, type, id: `${ns}:${path}`, data };
    }

    return { mod: mod.modId, type, id, found: false };
}
```

- [ ] **Step 3: Build** — should still compile since old functions haven't been removed.

```bash
npm run build
```

---

### Task 4: Update `server.ts` to use the new entry points

**Files:**
- Modify: `src/server.ts` (mod_data / mod_jar tool section)

- [ ] **Step 1: Find the mod_data (or mod_jar) tool in server.ts** — look for all switch cases that call the now-redundant specific functions:

```bash
grep -n "listModRecipes\|getModRecipe\|listModLootTables\|getModLootTable\|listModAdvancements\|getModAdvancement\|listModBlockstates\|getModBlockstate\|listModModels\|getModModel\|listModBiomes\|getModBiome\|listModStructures\|getModStructureData\|listModParticles" src/server.ts
```

- [ ] **Step 2: For each matched case**, replace the specific function call with `listModData` or `getModData`:

Example — before:
```ts
case "list_recipes":   result = await listModRecipes(modId!, namespace, filter); break;
case "get_recipe":     result = await getModRecipe(modId!, path!, namespace); break;
case "list_loot_tables": result = await listModLootTables(modId!, namespace, filter); break;
```

After:
```ts
case "list_recipes":     result = await listModData(modId!, "recipe", { namespace, filter }); break;
case "get_recipe":       result = await getModData(modId!, "recipe", path!, { namespace }); break;
case "list_loot_tables": result = await listModData(modId!, "loot_table", { namespace, filter }); break;
```

- [ ] **Step 3: Update the imports** in server.ts — replace the individual function imports with `listModData, getModData` (plus retain `listModJarFiles`, `getModJarFile`, `getModLang`, `getModSounds`, `listModDataTags`, `getModDataTag`).

- [ ] **Step 4: Build**
```bash
npm run build
```
Expected: any remaining errors are from callers of functions not yet removed — fix import by import.

---

### Task 5: Delete the now-redundant specific functions

**Files:**
- Modify: `src/tools/mod-data.ts`

- [ ] **Step 1: Verify no remaining callers** of the old specific functions:
```bash
grep -rn "listModRecipes\|getModRecipe\|listModLootTables\|getModLootTable\|listModAdvancements\|getModAdvancement\|listModBlockstates\|getModBlockstate\|listModModels\|getModModel\|listModBiomes\|getModBiome\|listModStructures\|getModStructureData\|listModParticles" src/
```
Expected: zero results.

- [ ] **Step 2: Delete each redundant function** from `mod-data.ts`. Keep:
  - `listModJarFiles`
  - `getModJarFile`
  - `getModLang`
  - `getModSounds`
  - `listModDataTags` / `getModDataTag`
  - `listModData` / `getModData` (new)
  - All internal helpers (`resolveMod`, `detectNamespaces`, `readJson`, `listJsonEntries`)

- [ ] **Step 3: Final build**
```bash
npm run build
```
Expected: zero errors.

- [ ] **Step 4: Commit and push**
```bash
git add src/tools/mod-data.ts src/server.ts
git commit -m "refactor: registry-driven mod-data — 40 shallow functions → 2 deep entry points + descriptor table"
git push
```

---

### Task 6: Verify the interface

- [ ] **Step 1: Count remaining exported functions in `mod-data.ts`**
```bash
grep -c "^export async function" src/tools/mod-data.ts
```
Expected: ≤ 8 (listModJarFiles, getModJarFile, getModLang, getModSounds, listModDataTags, getModDataTag, listModData, getModData).

- [ ] **Step 2: Spot-check one action through the MCP tool** — restart the server and call:
```
mod_data action=list_recipes modId=<any ingested mod>
mod_data action=get_recipe modId=<same mod> path=<a recipe from the list>
```
Expected: same result as before the refactor.
