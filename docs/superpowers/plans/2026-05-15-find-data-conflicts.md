# findDataConflicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `findDataConflicts` function to `packtools.ts` that detects when multiple mods ship the same data resource path (recipe, loot table, advancement, etc.), and register it as an MCP tool.

**Architecture:** Mirrors the existing `findAssetConflicts` pattern exactly — iterate all mod JARs, collect `data/` entries into a `path → owners[]` map, return paths with 2+ owners. Tag paths under `data/minecraft/` as vanilla override conflicts (higher significance). Registered as a new `action` on the existing `pack_tools` server handler.

**Tech Stack:** TypeScript ESM, AdmZip, Prisma (`listModsSlim`), `listEntries` from `jar.ts`, Vitest.

---

### Task 1: Write the failing test

**Files:**
- Create: `src/tools/packtools.test.ts` (or modify if it already exists — check first)

- [ ] **Step 1: Check whether `src/tools/packtools.test.ts` already exists.** If it does, read it; otherwise create it from scratch.

- [ ] **Step 2: Write a failing test for `findDataConflicts`.** Mock `listModsSlim` and `listEntries`. Provide two mock mods that both ship `data/minecraft/recipe/oak_planks.json` and one that alone ships `data/mymod/recipe/copper_thing.json`. Assert the result has `totalConflicts: 1`, the conflict path is the shared recipe, `isVanillaOverride: true`, and `modCount: 2`. Also assert `modsScanned: 2`.

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { findDataConflicts } from "./packtools.js";

  vi.mock("../repositories/mod.js", () => ({
      listModsSlim: vi.fn(),
  }));
  vi.mock("../jar.js", () => ({
      listEntries: vi.fn(),
  }));

  import { listModsSlim } from "../repositories/mod.js";
  import { listEntries } from "../jar.js";

  describe("findDataConflicts", () => {
      beforeEach(() => vi.resetAllMocks());

      it("detects vanilla override conflict across two mods", async () => {
          vi.mocked(listModsSlim).mockResolvedValue([
              { id: 1, modId: "mod_a", displayName: "Mod A", version: "1.0", jarPath: "/a.jar", loader: "neoforge", mcVersion: "1.21" },
              { id: 2, modId: "mod_b", displayName: "Mod B", version: "1.0", jarPath: "/b.jar", loader: "neoforge", mcVersion: "1.21" },
          ]);
          vi.mocked(listEntries)
              .mockReturnValueOnce([
                  "data/minecraft/recipe/oak_planks.json",
                  "data/mymod/recipe/copper_thing.json",
              ])
              .mockReturnValueOnce([
                  "data/minecraft/recipe/oak_planks.json",
              ]);

          const result = await findDataConflicts() as any;

          expect(result.totalConflicts).toBe(1);
          expect(result.modsScanned).toBe(2);
          expect(result.conflicts).toHaveLength(1);
          expect(result.conflicts[0].path).toBe("data/minecraft/recipe/oak_planks.json");
          expect(result.conflicts[0].isVanillaOverride).toBe(true);
          expect(result.conflicts[0].modCount).toBe(2);
          expect(result.vanillaOverrideConflicts).toBe(1);
      });

      it("filters by dataType", async () => {
          vi.mocked(listModsSlim).mockResolvedValue([
              { id: 1, modId: "mod_a", displayName: "Mod A", version: "1.0", jarPath: "/a.jar", loader: "neoforge", mcVersion: "1.21" },
              { id: 2, modId: "mod_b", displayName: "Mod B", version: "1.0", jarPath: "/b.jar", loader: "neoforge", mcVersion: "1.21" },
          ]);
          vi.mocked(listEntries)
              .mockReturnValueOnce([
                  "data/minecraft/recipe/oak_planks.json",
                  "data/minecraft/loot_tables/blocks/stone.json",
              ])
              .mockReturnValueOnce([
                  "data/minecraft/recipe/oak_planks.json",
                  "data/minecraft/loot_tables/blocks/stone.json",
              ]);

          // Filter to recipe only — should only see the recipe conflict
          const result = await findDataConflicts("recipe") as any;
          expect(result.totalConflicts).toBe(1);
          expect(result.conflicts[0].path).toContain("/recipe/");
      });

      it("returns no conflicts when all paths are unique", async () => {
          vi.mocked(listModsSlim).mockResolvedValue([
              { id: 1, modId: "mod_a", displayName: "Mod A", version: "1.0", jarPath: "/a.jar", loader: "neoforge", mcVersion: "1.21" },
          ]);
          vi.mocked(listEntries).mockReturnValueOnce(["data/mymod/recipe/thing.json"]);

          const result = await findDataConflicts() as any;
          expect(result.totalConflicts).toBe(0);
          expect(result.conflicts).toHaveLength(0);
      });
  });
  ```

- [ ] **Step 3: Run the tests to confirm they fail.**
  ```
  npx vitest run src/tools/packtools.test.ts
  ```
  Expected: `findDataConflicts is not a function` (or similar).

---

### Task 2: Implement `findDataConflicts`

**Files:**
- Modify: `src/tools/packtools.ts` (append after `findAssetConflicts`)

- [ ] **Step 1: Append the `findDataConflicts` function.** Follow the exact same pattern as `findAssetConflicts` — same import set, same `pathMap` approach.

  ```typescript
  // ── Data conflict detection ────────────────────────────────────────────────────

  /**
   * Scan all mod JARs for duplicate data resource paths.
   * When two mods ship the same data/ path, the last-loaded mod silently wins.
   *
   * dataType: filter to specific data sub-folder (recipe | loot_tables | advancements |
   *           tags | structures | all)
   * mcVersion / loader: optional DB filters
   * limit: max conflicts to return (default 300)
   */
  export async function findDataConflicts(
      dataType?: string,
      mcVersion?: string,
      loader?: string,
      limit = 300,
  ): Promise<object> {
      const mods = await listModsSlim({ mcVersion, loader });

      const typeFilter = dataType && dataType !== "all" ? dataType : null;
      const pathMap = new Map<string, Array<{ mod: string; display: string }>>();

      for (const mod of mods) {
          try {
              const entries = listEntries(mod.jarPath, "data/");
              for (const entry of entries) {
                  if (entry.endsWith("/")) continue;
                  if (typeFilter && !entry.includes(`/${typeFilter}/`)) continue;
                  const list = pathMap.get(entry) ?? [];
                  list.push({ mod: mod.modId, display: mod.displayName });
                  pathMap.set(entry, list);
              }
          } catch { /* skip unreadable JARs */ }
      }

      // Collect only conflicting paths (2+ owners)
      const conflicts: Array<{
          path: string;
          isVanillaOverride: boolean;
          modCount: number;
          mods: Array<{ mod: string; display: string }>;
      }> = [];

      for (const [path, owners] of pathMap) {
          if (owners.length < 2) continue;
          conflicts.push({
              path,
              isVanillaOverride: path.startsWith("data/minecraft/"),
              modCount: owners.length,
              mods: owners,
          });
      }

      conflicts.sort((a, b) => b.modCount - a.modCount);

      const capped = conflicts.length > limit;
      const limited = conflicts.slice(0, limit);

      // byType breakdown
      const byType: Record<string, number> = {};
      for (const c of limited) {
          const parts = c.path.split("/");
          // path = data/<namespace>/<type>/...  → parts[2]
          const t = parts[2] ?? "unknown";
          byType[t] = (byType[t] ?? 0) + 1;
      }

      const vanillaOverrideConflicts = limited.filter((c) => c.isVanillaOverride).length;

      return {
          modsScanned: mods.length,
          totalConflicts: limited.length,
          capped,
          byType,
          vanillaOverrideConflicts,
          note: capped ? `Results capped at ${limit}. Use dataType or loader/mcVersion to narrow.` : "",
          conflicts: limited,
      };
  }
  ```

- [ ] **Step 2: Run the tests again — they should pass.**
  ```
  npx vitest run src/tools/packtools.test.ts
  ```

- [ ] **Step 3: Run the full suite to confirm no regressions.**
  ```
  npx vitest run
  ```

---

### Task 3: Register in server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Find the `pack_tools` tool handler in `server.ts`.** Look for the block that handles `findAssetConflicts`. It will be inside a `server.tool("pack_tools", ...)` call or similar.

- [ ] **Step 2: Import `findDataConflicts` alongside the existing packtools imports.**

- [ ] **Step 3: Add `find_data_conflicts` as a new action (or standalone tool).** Follow whichever pattern the other packtools actions use. If they're in a switch/case on an `action` parameter, add a new case. Example skeleton:

  ```typescript
  // Inside pack_tools handler or as a standalone tool:
  case "find_data_conflicts": {
      const dataType = args.dataType as string | undefined;
      const result   = await findDataConflicts(dataType, args.mcVersion as string, args.loader as string);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  ```
  
  If `pack_tools` uses a flat parameter schema, add `dataType` as an optional enum field:
  `dataType: z.enum(["recipe","loot_tables","advancements","tags","structures","all"]).optional()`

- [ ] **Step 4: Run `tsc --noEmit` to confirm no type errors.**
  ```
  npx tsc --noEmit
  ```

---

### Task 4: Commit

- [ ] **Step 1: Stage and commit.**
  ```
  git add src/tools/packtools.ts src/tools/packtools.test.ts src/server.ts
  git commit -m "feat: add findDataConflicts tool to packtools"
  ```
