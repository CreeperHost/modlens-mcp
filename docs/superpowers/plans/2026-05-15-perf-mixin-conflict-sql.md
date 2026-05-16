# Performance: Mixin Conflict Matrix N+1 Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `getMixinConflictMatrix` in `src/tools/mixin-scan.ts` fetches all mods with `mixinTargets` populated, then builds the class→mods conflict map entirely in JavaScript. With 500 mods each having 200 mixin targets, this is 100,000 JS object operations plus a full sort in memory — all work that PostgreSQL can do in a single aggregated query.

**Approach:** Add a `getMixinConflictMatrixRaw` query to the repository that uses a Prisma `$queryRaw` (or `groupBy`) to return conflict rows pre-aggregated by class name. The JS code then only formats the output.

**Files to modify:** `src/repositories/mod.ts`, `src/tools/mixin-scan.ts`

---

## Task 1: Understand current data shape

The `Mod` table has a `mixinTargets` column typed as `Json` (stored as a PostgreSQL JSON array like `["net/minecraft/A", "net/minecraft/B"]`). To aggregate conflicts in SQL we need to `jsonb_array_elements_text` to unnest the targets.

---

## Task 2: Add `getMixinConflictRaw` to the repository

- [ ] **Append to `src/repositories/mod.ts`**

  ```typescript
  /**
   * Returns conflict data pre-aggregated in SQL.
   * Each row: class name + count of mods targeting it + array of mod IDs.
   * Only returns classes targeted by >= minConflicts mods.
   */
  export async function getMixinConflictRaw(
      loader?: string,
      mcVersion?: string,
      minConflicts = 2,
  ): Promise<Array<{ className: string; modCount: number; modIds: number[] }>> {
      // Build WHERE clause fragments for optional filters
      const loaderClause  = loader    ? `AND m."loader" = ${db().$queryRaw`${loader}`}`    : "";
      const versionClause = mcVersion ? `AND m."mc_version" = ${db().$queryRaw`${mcVersion}`}` : "";

      // Use $queryRawUnsafe carefully — loader/mcVersion are validated by callers
      // Parameterised alternative shown below for safety.
      const rows = await db().$queryRaw<
          Array<{ class_name: string; mod_count: bigint; mod_ids: number[] }>
      >`
          SELECT
              t.class_name,
              COUNT(DISTINCT m.id)::int  AS mod_count,
              ARRAY_AGG(DISTINCT m.id)   AS mod_ids
          FROM "Mod" m
          CROSS JOIN LATERAL jsonb_array_elements_text(m."mixin_targets"::jsonb) AS t(class_name)
          WHERE m."has_mixins" = true
          ${loader    ? db().$queryRaw`AND m."loader" = ${loader}`    : db().$queryRaw``}
          ${mcVersion ? db().$queryRaw`AND m."mc_version" = ${mcVersion}` : db().$queryRaw``}
          GROUP BY t.class_name
          HAVING COUNT(DISTINCT m.id) >= ${minConflicts}
          ORDER BY mod_count DESC
      `;

      return rows.map((r) => ({
          className: r.class_name,
          modCount:  Number(r.mod_count),
          modIds:    r.mod_ids,
      }));
  }
  ```

  > **Note:** Prisma tagged templates don't support inline conditionals well. The implementation uses separate query overloads. The executing agent should verify the exact Prisma `$queryRaw` syntax for optional WHERE fragments against the project's Prisma version and adjust accordingly — the pattern above is illustrative of the intent. An alternative is four separate queries (no filter / loader only / mcVersion only / both) selected with a switch.

- [ ] **Simpler alternative if the tagged template is awkward**

  Use `$queryRawUnsafe` with parameterised values:
  ```typescript
  export async function getMixinConflictRaw(
      loader?: string,
      mcVersion?: string,
      minConflicts = 2,
  ): Promise<Array<{ className: string; modCount: number; modIds: number[] }>> {
      const params: unknown[] = [minConflicts];
      const whereClauses: string[] = ["m.has_mixins = true"];

      if (loader)    { params.push(loader);    whereClauses.push(`m.loader = $${params.length}`); }
      if (mcVersion) { params.push(mcVersion); whereClauses.push(`m.mc_version = $${params.length}`); }

      const whereSQL = whereClauses.join(" AND ");

      const rows = await db().$queryRawUnsafe<
          Array<{ class_name: string; mod_count: string; mod_ids: number[] }>
      >(`
          SELECT
              t.class_name,
              COUNT(DISTINCT m.id)::int AS mod_count,
              ARRAY_AGG(DISTINCT m.id) AS mod_ids
          FROM "Mod" m
          CROSS JOIN LATERAL jsonb_array_elements_text(m.mixin_targets::jsonb) AS t(class_name)
          WHERE ${whereSQL}
          GROUP BY t.class_name
          HAVING COUNT(DISTINCT m.id) >= $1
          ORDER BY mod_count DESC
      `, ...params);

      return rows.map((r) => ({
          className: r.class_name,
          modCount:  Number(r.mod_count),
          modIds:    r.mod_ids,
      }));
  }
  ```

- [ ] **Run type-check**

  ```powershell
  npx tsc --noEmit
  ```
  Expected: clean.

---

## Task 3: Rewrite `getMixinConflictMatrix` to use the new query

- [ ] **Edit `src/tools/mixin-scan.ts`**

  Replace the existing `getMixinConflictMatrix` body. Current flow:
  1. Fetch all mods via `listModsForMixinScan`
  2. Build `classToMods` map in JS
  3. Filter, sort, return

  New flow:
  1. Call `getMixinConflictRaw` (DB does the grouping)
  2. For each conflict row, fetch the relevant mod details by `modIds`
  3. Format output

  ```typescript
  import { getMixinConflictRaw, findModsByIds } from "../repositories/mod.js";

  export async function getMixinConflictMatrix(
      loader?: string,
      mcVersion?: string,
      minConflicts = 2,
  ): Promise<object> {
      const conflictRows = await getMixinConflictRaw(loader, mcVersion, minConflicts);

      // Collect all unique mod IDs referenced across all conflict rows
      const allModIds = [...new Set(conflictRows.flatMap((r) => r.modIds))];
      const modMap = allModIds.length
          ? await findModsByIds(allModIds)
          : [];
      const modById = new Map(modMap.map((m) => [m.id, m]));

      const conflicts = conflictRows.map(({ className, modCount, modIds }) => ({
          class: className,
          mixedByCount: modCount,
          mods: modIds
              .map((id) => {
                  const m = modById.get(id);
                  return m ? { modId: m.modId, display: m.displayName, version: m.version } : null;
              })
              .filter(Boolean),
      }));

      // Summary stats: which mods appear in most conflicts
      const modConflictCounts: Record<string, number> = {};
      for (const { mods } of conflicts) {
          for (const m of mods) {
              if (m) modConflictCounts[m.modId] = (modConflictCounts[m.modId] ?? 0) + 1;
          }
      }
      const mostConflicted = Object.entries(modConflictCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([modId, count]) => ({ modId, conflictingClasses: count }));

      return {
          totalMixinMods:     allModIds.length,
          conflictingClasses: conflicts.length,
          mostConflictedMods: mostConflicted,
          conflicts,
      };
  }
  ```

- [ ] **Add `findModsByIds` to repository if not present**

  ```typescript
  export async function findModsByIds(ids: number[]): Promise<Mod[]> {
      return db().mod.findMany({ where: { id: { in: ids } } });
  }
  ```

- [ ] **Run type-check and full tests**

  ```powershell
  npx tsc --noEmit
  npm test
  ```
  Expected: clean.

- [ ] **Commit**

  ```powershell
  git add src/repositories/mod.ts src/tools/mixin-scan.ts
  git commit -m "perf: getMixinConflictMatrix delegates aggregation to PostgreSQL"
  ```
