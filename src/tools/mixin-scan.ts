/**
 * Cross-mod mixin scanner.
 *
 * Tools for seeing the full mixin picture across all ingested mods:
 *   - List every mod that has mixins (without having to call getMixinTargets per mod)
 *   - Full conflict matrix: for each class, every mod that mixes into it
 *   - Summary: most-contested classes, mods with the most mixins, etc.
 */
import { listModsForMixinScan, listModsSlim, findModsByIds } from "../repositories/mod.js";
import { getDb } from "../db.js";

type MixinMod = {
    id: number;
    modId: string;
    displayName: string;
    version: string;
    mcVersion: string;
    loader: string;
    mixinTargets: unknown;
    mixinConfigs: string[];
};

// ── Private helpers ───────────────────────────────────────────────────────────

async function mixinConflictRaw(
    loader?: string,
    mcVersion?: string,
    minConflicts = 2,
): Promise<Array<{ className: string; modCount: number; modIds: number[] }>> {
    const params: unknown[] = [minConflicts];
    const whereClauses: string[] = ["has_mixins = true"];

    if (loader)    { params.push(loader);    whereClauses.push(`loader = $${params.length}`); }
    if (mcVersion) { params.push(mcVersion); whereClauses.push(`mc_version = $${params.length}`); }

    const whereSQL = whereClauses.join(" AND ");

    const db = await getDb();
    const rows = await db.$queryRawUnsafe<
        Array<{ class_name: string; mod_count: string; mod_ids: number[] }>
    >(`
        WITH deduped AS (
            SELECT DISTINCT ON (mod_id) id, mod_id, mixin_targets
            FROM "mods"
            WHERE ${whereSQL}
            ORDER BY mod_id, id DESC
        )
        SELECT
            t.class_name,
            COUNT(DISTINCT d.mod_id)::int AS mod_count,
            ARRAY_AGG(DISTINCT d.id) AS mod_ids
        FROM deduped d
        CROSS JOIN LATERAL jsonb_array_elements_text(d.mixin_targets::jsonb) AS t(class_name)
        GROUP BY t.class_name
        HAVING COUNT(DISTINCT d.mod_id) >= $1
        ORDER BY mod_count DESC
    `, ...params);

    return rows.map((r) => ({
        className: r.class_name,
        modCount:  Number(r.mod_count),
        modIds:    r.mod_ids,
    }));
}

// ── Public tools ──────────────────────────────────────────────────────────────

/**
 * List all ingested mods that have mixins, with their target classes.
 * Does NOT scan JARs — reads resolved mixinTargets from DB (populated by resolve_mixin_targets).
 */
export async function listModsWithMixins(loader?: string, mcVersion?: string): Promise<object> {
    const mods = (await listModsForMixinScan({ hasMixins: true, loader, mcVersion })) as MixinMod[];

    return {
        count: mods.length,
        mods: mods.map((m) => {
            const targets = (m.mixinTargets as string[]) ?? [];
            return {
                dbId:         m.id,
                modId:        m.modId,
                display:      m.displayName,
                version:      m.version,
                mcVersion:    m.mcVersion,
                loader:       m.loader,
                mixinConfigs: m.mixinConfigs,
                targetCount:  targets.length,
                targets:      targets,
            };
        }),
    };
}

/**
 * Full cross-mod mixin conflict matrix.
 *
 * Returns every class that is targeted by 2+ mods, with all mods listed.
 * Uses resolved mixinTargets from the DB.
 */
export async function getMixinConflictMatrix(
    loader?: string,
    mcVersion?: string,
    minConflicts = 2,
): Promise<object> {
    const conflictRows = await mixinConflictRaw(loader, mcVersion, minConflicts);

    // Collect all unique mod IDs referenced across all conflict rows
    const allModIds = [...new Set(conflictRows.flatMap((r) => r.modIds))];
    const modList = allModIds.length ? await findModsByIds(allModIds) : [];
    const modById = new Map(modList.map((m) => [m.id, m]));

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

    // Summary stats
    const modConflictCounts: Record<string, number> = {};
    for (const { mods } of conflicts) {
        for (const m of mods as Array<{ modId: string }>) {
            modConflictCounts[m.modId] = (modConflictCounts[m.modId] ?? 0) + 1;
        }
    }
    const mostConflicted = Object.entries(modConflictCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([modId, count]) => ({ modId, conflictingClasses: count }));

    return {
        totalMixinMods:     allModIds.length,
        totalTargetClasses: conflictRows.length,
        conflictingClasses: conflicts.length,
        mostConflictedMods: mostConflicted,
        conflicts,
    };
}

/**
 * For a single class, show every mod that mixes into it — same as getMixinConflicts
 * in mixins.ts but includes richer context.
 */
export async function getMixinClassDetail(targetClass: string): Promise<object> {
    // Normalise separators
    const normalClass = targetClass.replace(/\./g, "/");

    const all = await listModsForMixinScan({ hasMixins: true });
    const mods = all.filter((m) => (m.mixinTargets as string[])?.includes(normalClass));

    return {
        targetClass:  normalClass,
        modCount:     mods.length,
        isConflicted: mods.length > 1,
        mods: mods.map((m) => ({
            dbId:         m.id,
            modId:        m.modId,
            display:      m.displayName,
            version:      m.version,
            mcVersion:    m.mcVersion,
            loader:       m.loader,
            mixinConfigs: m.mixinConfigs,
        })),
    };
}

/**
 * Top-N most contested classes by number of mods targeting them.
 */
export async function getMixinHotspots(top = 20, loader?: string): Promise<object> {
    const mods = await listModsForMixinScan({ hasMixins: true, loader });

    const counts: Record<string, number> = {};
    for (const mod of mods) {
        for (const cls of (mod.mixinTargets as string[]) ?? []) {
            counts[cls] = (counts[cls] ?? 0) + 1;
        }
    }

    const hotspots = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([cls, count]) => ({ class: cls, modCount: count }));

    return { top, totalClasses: Object.keys(counts).length, hotspots };
}

/**
 * Resolve @Mixin targets for every hasMixins=true mod in the DB.
 * Reads bytecode annotations and updates mixinTargets column.
 * Returns a per-mod summary plus totals.
 */
export async function batchResolveMixins(
    loader?: string,
    mcVersion?: string,
): Promise<object> {
    const { resolveMixinTargets } = await import("./mixins.js");

    const mods = await listModsForMixinScan({ hasMixins: true, loader, mcVersion });

    let resolved = 0, noneFound = 0, failed = 0;
    const results: Array<{ dbId: number; modId: string; version: string; status: string; targets: number }> = [];

    for (const mod of mods) {
        try {
            const r = await resolveMixinTargets(mod.id);
            if (r.targets.length === 0) {
                noneFound++;
                results.push({ dbId: mod.id, modId: mod.modId, version: mod.version, status: "none", targets: 0 });
            } else {
                resolved++;
                results.push({ dbId: mod.id, modId: mod.modId, version: mod.version, status: "ok", targets: r.targets.length });
            }
        } catch (e) {
            failed++;
            const msg = e instanceof Error ? e.message : String(e);
            results.push({ dbId: mod.id, modId: mod.modId, version: mod.version, status: `error: ${msg.slice(0, 80)}`, targets: 0 });
        }
    }

    return {
        total: mods.length,
        resolved,
        noneFound,
        failed,
        results,
    };
}
