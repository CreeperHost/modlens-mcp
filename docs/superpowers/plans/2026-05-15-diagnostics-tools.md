# Diagnostics Tools (analyzeCrashLog + findMissingDeps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `src/tools/diagnostics.ts` with two tools: `analyzeCrashLog` (ranks suspect mods from a crash log by cross-referencing stack frames against the `ModClass` table) and `findMissingDeps` (finds declared mod dependencies that aren't satisfied by ingested mods). Register both as MCP tools in `server.ts`.

**Architecture:** `analyzeCrashLog` extracts Java class names from stack frames using regex, normalises them to slash-form, bulk-queries the `ModClass` table (which is populated by `reindexClasses`), and ranks mods by frame count. It also parses the NeoForge/Forge `-- Mod List --` section as a cross-reference. `findMissingDeps` reads the `dependencies` JSON column from all ingested mods, collects the full ingested modId set, and flags any referenced modId that's absent. Both functions are pure: no side effects, no file writes.

**Tech Stack:** TypeScript ESM, Prisma (`db()` for `ModClass` queries, `listAllMods`), Vitest.

---

### Prerequisite: New repository function

**Files:**
- Modify: `src/repositories/mod.ts`

- [ ] **Step 1: Add `findModClassesByClassNames` to `src/repositories/mod.ts`.** This does a bulk lookup of class names against the `ModClass` table and returns rows joined to their parent `Mod`.

  Append after the existing ModClass query block (near line 279):

  ```typescript
  /**
   * Bulk-lookup: given a list of class names (slash-form), return all ModClass
   * rows with their parent mod info. Used by analyzeCrashLog.
   */
  export async function findModClassesByClassNames(
      classNames: string[],
  ): Promise<Array<{ className: string; modId: number; mod: { modId: string; displayName: string } }>> {
      if (classNames.length === 0) return [];
      return db().modClass.findMany({
          where: { className: { in: classNames } },
          select: {
              className: true,
              modId: true,
              mod: { select: { modId: true, displayName: true } },
          },
      }) as Promise<Array<{ className: string; modId: number; mod: { modId: string; displayName: string } }>>;
  }
  ```

- [ ] **Step 2: Run `tsc --noEmit` to confirm no type errors.**
  ```
  npx tsc --noEmit
  ```

---

### Task 1: Create `src/tools/diagnostics.ts` (skeleton + types)

**Files:**
- Create: `src/tools/diagnostics.ts`

- [ ] **Step 1: Create the file with module header, imports, and exported function stubs.** Do not implement logic yet — just enough for the file to compile.

  ```typescript
  /**
   * Diagnostics tools for modpack developers.
   *
   * - analyzeCrashLog: rank suspect mods from a NeoForge/Fabric/Forge crash log
   *   by cross-referencing stack frames with the ModClass index.
   * - findMissingDeps: find declared dependencies not satisfied by ingested mods.
   */

  import { findModClassesByClassNames, listAllMods } from "../repositories/mod.js";

  // Loader-level pseudo-deps that are never in the mod DB
  const SKIP_DEP_IDS = new Set([
      "minecraft", "neoforge", "forge", "fabric-api",
      "fabricloader", "quilt_loader", "java",
  ]);

  export async function analyzeCrashLog(_logText: string): Promise<object> {
      return {};
  }

  export async function findMissingDeps(_mcVersion?: string, _loader?: string): Promise<object> {
      return {};
  }
  ```

- [ ] **Step 2: Run `tsc --noEmit` — should compile clean.**

---

### Task 2: Write failing tests

**Files:**
- Create: `src/tools/diagnostics.test.ts`

- [ ] **Step 1: Write tests for `analyzeCrashLog`.**

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { analyzeCrashLog, findMissingDeps } from "./diagnostics.js";

  vi.mock("../repositories/mod.js", () => ({
      findModClassesByClassNames: vi.fn(),
      listAllMods: vi.fn(),
  }));

  import { findModClassesByClassNames, listAllMods } from "../repositories/mod.js";

  const SAMPLE_CRASH = `
  ---- Minecraft Crash Report ----
  java.lang.NullPointerException: Cannot invoke method
  \tat net.minecraft.world.level.Level.tickChunk(Level.java:345)
  \tat com.example.mymod.MyWorldMixin.tickChunk(MyWorldMixin.java:12)
  \tat net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:890)
  \tat com.example.other.OtherMixin.runServer(OtherMixin.java:5)
  \tat com.example.other.OtherMixin.extra(OtherMixin.java:30)

  -- Mod List --
  mymod|1.0
  othermod|2.0
  `;

  describe("analyzeCrashLog", () => {
      beforeEach(() => vi.resetAllMocks());

      it("ranks mods by frame count and returns suspects", async () => {
          vi.mocked(findModClassesByClassNames).mockResolvedValue([
              { className: "com/example/mymod/MyWorldMixin",  modId: 1, mod: { modId: "mymod",    displayName: "My Mod"    } },
              { className: "com/example/other/OtherMixin",    modId: 2, mod: { modId: "othermod", displayName: "Other Mod" } },
              { className: "com/example/other/OtherMixin",    modId: 2, mod: { modId: "othermod", displayName: "Other Mod" } },
          ]);

          const result = await analyzeCrashLog(SAMPLE_CRASH) as any;

          expect(result.suspects).toHaveLength(2);
          // othermod has 2 frames — should rank first
          expect(result.suspects[0].modId).toBe("othermod");
          expect(result.suspects[0].frameCount).toBe(2);
          expect(result.suspects[1].modId).toBe("mymod");
          expect(result.suspects[1].frameCount).toBe(1);
      });

      it("reports unrecognized frames", async () => {
          vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
          const result = await analyzeCrashLog(SAMPLE_CRASH) as any;
          expect(result.unrecognizedFrames).toBeGreaterThan(0);
          expect(result.coverageWarning).toBeDefined();
      });

      it("returns empty suspects for empty log", async () => {
          vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
          const result = await analyzeCrashLog("") as any;
          expect(result.suspects).toHaveLength(0);
          expect(result.totalFrames).toBe(0);
      });
  });

  describe("findMissingDeps", () => {
      beforeEach(() => vi.resetAllMocks());

      it("flags a mod dependency that is not ingested", async () => {
          vi.mocked(listAllMods).mockResolvedValue([
              {
                  id: 1, modId: "mymod", displayName: "My Mod", version: "1.0",
                  mcVersion: "1.21", loader: "neoforge", jarPath: "/a.jar",
                  dependencies: JSON.stringify([
                      { id: "requiredmod", version: ">=1.0", required: true },
                      { id: "minecraft", version: "1.21", required: true },
                  ]),
              },
          ] as any);

          const result = await findMissingDeps() as any;
          expect(result.unsatisfied).toBe(1);
          expect(result.missing[0].depModId).toBe("requiredmod");
          expect(result.missing[0].requiredBy).toBe("mymod");
      });

      it("ignores loader-level pseudo-deps (minecraft, neoforge, etc.)", async () => {
          vi.mocked(listAllMods).mockResolvedValue([
              {
                  id: 1, modId: "mymod", displayName: "My Mod", version: "1.0",
                  mcVersion: "1.21", loader: "neoforge", jarPath: "/a.jar",
                  dependencies: JSON.stringify([
                      { id: "minecraft", version: "1.21", required: true },
                      { id: "neoforge",  version: ">=21", required: true },
                      { id: "java",      version: ">=21", required: true },
                  ]),
              },
          ] as any);

          const result = await findMissingDeps() as any;
          expect(result.unsatisfied).toBe(0);
          expect(result.missing).toHaveLength(0);
      });

      it("reports satisfied when dep is ingested", async () => {
          vi.mocked(listAllMods).mockResolvedValue([
              {
                  id: 1, modId: "mymod", displayName: "My Mod", version: "1.0",
                  mcVersion: "1.21", loader: "neoforge", jarPath: "/a.jar",
                  dependencies: JSON.stringify([{ id: "lib", version: "1.0", required: true }]),
              },
              {
                  id: 2, modId: "lib", displayName: "Lib", version: "1.0",
                  mcVersion: "1.21", loader: "neoforge", jarPath: "/lib.jar",
                  dependencies: JSON.stringify([]),
              },
          ] as any);

          const result = await findMissingDeps() as any;
          expect(result.satisfied).toBe(1);
          expect(result.unsatisfied).toBe(0);
      });
  });
  ```

- [ ] **Step 2: Run the tests — confirm they all fail.**
  ```
  npx vitest run src/tools/diagnostics.test.ts
  ```

---

### Task 3: Implement `analyzeCrashLog`

**Files:**
- Modify: `src/tools/diagnostics.ts`

- [ ] **Step 1: Implement the function body.**

  Key implementation notes:
  - Stack frame regex: `/\tat ([\w.$]+)\.([\w$<>[\]]+)\(/g` — capture the class part (group 1).
  - Normalise class name: replace all `.` with `/` → `"com.example.Foo"` → `"com/example/Foo"`.
  - Deduplicate class names before querying the DB (avoid N×queries for repeated frames, but keep per-frame counts).
  - After DB lookup, build a `Map<string, {modId, display}>` from className → mod. Then iterate the original (non-deduped) extracted classes and accumulate frame counts per mod.
  - NeoForge "Mod List" section regex: `/^(\S+)\|[\S ]+$/gm` on the section between `-- Mod List --` and the next `--` heading.
  - Coverage warning threshold: if `unrecognizedFrames / totalFrames > 0.5` (and `totalFrames > 5`), emit `coverageWarning`.
  - Return top 10 suspects max (configurable via constant `MAX_SUSPECTS = 10`).
  - `frames` in each suspect = deduplicated class names matching that mod (top 5).

  ```typescript
  export async function analyzeCrashLog(logText: string): Promise<object> {
      const FRAME_RE = /\tat ([\w.$]+)\.([\w$<>[\]]+)\(/g;
      const rawFrames: string[] = [];
      for (const m of logText.matchAll(FRAME_RE)) {
          rawFrames.push(m[1].replace(/\./g, "/"));
      }

      if (rawFrames.length === 0) {
          return {
              suspects: [],
              modsInLogSection: [],
              totalFrames: 0,
              recognizedFrames: 0,
              unrecognizedFrames: 0,
          };
      }

      const uniqueClasses = [...new Set(rawFrames)];
      const rows = await findModClassesByClassNames(uniqueClasses);

      // className → mod info
      const classToMod = new Map<string, { modId: string; dbId: number; display: string }>();
      for (const row of rows) {
          classToMod.set(row.className, { modId: row.mod.modId, dbId: row.modId, display: row.mod.displayName });
      }

      // Accumulate frame counts
      const modFrameCount = new Map<number, { modId: string; display: string; dbId: number; frames: string[] }>();
      let recognized = 0;
      for (const cls of rawFrames) {
          const mod = classToMod.get(cls);
          if (!mod) continue;
          recognized++;
          const entry = modFrameCount.get(mod.dbId) ?? { modId: mod.modId, display: mod.display, dbId: mod.dbId, frames: [] };
          if (!entry.frames.includes(cls)) entry.frames.push(cls);
          modFrameCount.set(mod.dbId, entry);
      }

      // Build suspect list sorted by frame count (re-count from rawFrames)
      const suspects = [...modFrameCount.values()]
          .map((s) => ({
              modId: s.modId,
              display: s.display,
              dbId: s.dbId,
              frameCount: rawFrames.filter((c) => classToMod.get(c)?.dbId === s.dbId).length,
              frames: s.frames.slice(0, 5),
          }))
          .sort((a, b) => b.frameCount - a.frameCount)
          .slice(0, 10);

      // Parse "-- Mod List --" section (NeoForge crash format)
      const modListMatch = logText.match(/-- Mod List --\n([\s\S]*?)(?:\n--|$)/);
      const modsInLogSection: string[] = [];
      if (modListMatch) {
          for (const line of modListMatch[1].split("\n")) {
              const m = line.match(/^\s*(\S+)\|/);
              if (m) modsInLogSection.push(m[1].trim());
          }
      }

      const unrecognized = rawFrames.length - recognized;
      const coverageWarning =
          rawFrames.length > 5 && unrecognized / rawFrames.length > 0.5
              ? `${unrecognized}/${rawFrames.length} stack frames could not be matched to ingested mods. Run reindex_classes to improve coverage.`
              : undefined;

      return {
          suspects,
          modsInLogSection,
          totalFrames: rawFrames.length,
          recognizedFrames: recognized,
          unrecognizedFrames: unrecognized,
          ...(coverageWarning ? { coverageWarning } : {}),
      };
  }
  ```

- [ ] **Step 2: Run the tests — `analyzeCrashLog` tests should pass.**
  ```
  npx vitest run src/tools/diagnostics.test.ts
  ```

---

### Task 4: Implement `findMissingDeps`

**Files:**
- Modify: `src/tools/diagnostics.ts`

- [ ] **Step 1: Implement `findMissingDeps`.**

  Key notes:
  - `dependencies` is stored as a JSON column. Prisma returns it as `unknown` — cast to `Array<{id: string; version: string; required: boolean}>` with a try/catch fallback to `[]`.
  - Collect the ingested modId set from `listAllMods()` in one call (same call used to get dependencies).
  - Emit one `missing` entry per (requiredBy, depModId) pair.

  ```typescript
  export async function findMissingDeps(mcVersion?: string, loader?: string): Promise<object> {
      const allMods = await listAllMods();

      // Build the set of all ingested modIds
      const ingestedIds = new Set(allMods.map((m) => m.modId));

      // Filter pool to mcVersion/loader if requested
      const pool = allMods.filter((m) => {
          if (mcVersion && !m.mcVersion.includes(mcVersion)) return false;
          if (loader && m.loader !== loader) return false;
          return true;
      });

      type DepEntry = { id: string; version: string; required: boolean };
      const missing: Array<{
          requiredBy: string; requiredByDisplay: string;
          depModId: string; versionRange: string; mandatory: boolean;
      }> = [];
      let satisfied = 0;

      for (const mod of pool) {
          let deps: DepEntry[] = [];
          try { deps = (mod.dependencies as DepEntry[]) ?? []; }
          catch { deps = []; }

          for (const dep of deps) {
              if (SKIP_DEP_IDS.has(dep.id)) continue;
              if (ingestedIds.has(dep.id)) {
                  satisfied++;
              } else {
                  missing.push({
                      requiredBy: mod.modId,
                      requiredByDisplay: mod.displayName,
                      depModId: dep.id,
                      versionRange: dep.version ?? "*",
                      mandatory: dep.required ?? true,
                  });
              }
          }
      }

      return {
          mcVersion: mcVersion ?? "all",
          loader: loader ?? "all",
          modsChecked: pool.length,
          missing,
          satisfied,
          unsatisfied: missing.length,
      };
  }
  ```

- [ ] **Step 2: Run all diagnostics tests — all should pass.**
  ```
  npx vitest run src/tools/diagnostics.test.ts
  ```

- [ ] **Step 3: Run the full suite.**
  ```
  npx vitest run
  ```

---

### Task 5: Register in server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add imports.** Near the top of `server.ts` where other tools are imported:
  ```typescript
  import { analyzeCrashLog, findMissingDeps } from "./tools/diagnostics.js";
  ```

- [ ] **Step 2: Register `analyze_crash_log` tool.** Follow the exact registration pattern of existing tools (look at how `get_mixin_conflicts` is registered for the shape). Required input: `logText: z.string()`. Optional: none.

- [ ] **Step 3: Register `find_missing_deps` tool.** Inputs: `mcVersion: z.string().optional()`, `loader: z.string().optional()`.

- [ ] **Step 4: Run `tsc --noEmit`.**
  ```
  npx tsc --noEmit
  ```

---

### Task 6: Commit

- [ ] **Step 1: Stage and commit.**
  ```
  git add src/tools/diagnostics.ts src/tools/diagnostics.test.ts src/repositories/mod.ts src/server.ts
  git commit -m "feat: add analyzeCrashLog and findMissingDeps diagnostics tools"
  ```
