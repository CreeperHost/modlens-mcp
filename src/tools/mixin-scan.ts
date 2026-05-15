/**
 * Cross-mod mixin scanner.
 *
 * Tools for seeing the full mixin picture across all ingested mods:
 *   - List every mod that has mixins (without having to call getMixinTargets per mod)
 *   - Full conflict matrix: for each class, every mod that mixes into it
 *   - Summary: most-contested classes, mods with the most mixins, etc.
 */
import { db } from "../db.js";

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

// ── Public tools ──────────────────────────────────────────────────────────────

/**
 * List all ingested mods that have mixins, with their target classes.
 * Does NOT scan JARs — reads resolved mixinTargets from DB (populated by resolve_mixin_targets).
 */
export async function listModsWithMixins(loader?: string, mcVersion?: string): Promise<object> {
    const mods = await db().mod.findMany({
        where: {
            hasMixins: true,
            ...(loader    ? { loader }                                      : {}),
            ...(mcVersion ? { mcVersion: { contains: mcVersion } }          : {}),
        },
        select: {
            id: true, modId: true, displayName: true, version: true,
            mcVersion: true, loader: true, mixinTargets: true, mixinConfigs: true,
        },
        orderBy: { modId: "asc" },
    }) as MixinMod[];

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
    const mods = await db().mod.findMany({
        where: {
            hasMixins: true,
            ...(loader    ? { loader }                             : {}),
            ...(mcVersion ? { mcVersion: { contains: mcVersion } } : {}),
        },
        select: {
            modId: true, displayName: true, version: true,
            mcVersion: true, loader: true, mixinTargets: true,
        },
    });

    // class → [{ modId, displayName, version }]
    const classToMods: Record<string, Array<{ modId: string; display: string; version: string }>> = {};

    for (const mod of mods) {
        const targets = (mod.mixinTargets as string[]) ?? [];
        for (const cls of targets) {
            (classToMods[cls] ??= []).push({
                modId:   mod.modId,
                display: mod.displayName,
                version: mod.version,
            });
        }
    }

    const conflicts = Object.entries(classToMods)
        .filter(([, mods]) => mods.length >= minConflicts)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([cls, mods]) => ({ class: cls, mixedByCount: mods.length, mods }));

    // Summary stats
    const totalClasses = Object.keys(classToMods).length;
    const conflictClasses = conflicts.length;
    const modConflictCounts: Record<string, number> = {};
    for (const { mods } of conflicts) {
        for (const m of mods) {
            modConflictCounts[m.modId] = (modConflictCounts[m.modId] ?? 0) + 1;
        }
    }
    const mostConflicted = Object.entries(modConflictCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([modId, count]) => ({ modId, conflictingClasses: count }));

    return {
        totalMixinMods:      mods.length,
        totalTargetClasses:  totalClasses,
        conflictingClasses:  conflictClasses,
        mostConflictedMods:  mostConflicted,
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

    const mods = await db().mod.findMany({
        where: { mixinTargets: { array_contains: [normalClass] } },
        select: {
            id: true, modId: true, displayName: true, version: true,
            mcVersion: true, loader: true, mixinConfigs: true,
        },
        orderBy: { modId: "asc" },
    });

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
    const mods = await db().mod.findMany({
        where: {
            hasMixins: true,
            ...(loader ? { loader } : {}),
        },
        select: { modId: true, displayName: true, version: true, mixinTargets: true },
    });

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

    const mods = await db().mod.findMany({
        where: {
            hasMixins: true,
            ...(loader    ? { loader }                             : {}),
            ...(mcVersion ? { mcVersion: { contains: mcVersion } } : {}),
        },
        select: { id: true, modId: true, version: true },
        orderBy: { id: "asc" },
    });

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
