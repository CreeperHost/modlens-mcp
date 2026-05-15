import { db } from "../db.js";
import type { Mod } from "@prisma/client";

export async function listMods(opts: {
    loader?: string;
    mcVersion?: string;
    hasMixins?: boolean;
    decompiled?: boolean;
    limit?: number;
}): Promise<Mod[]> {
    return db().mod.findMany({
        where: {
            ...(opts.loader ? { loader: opts.loader } : {}),
            ...(opts.mcVersion ? { mcVersion: { contains: opts.mcVersion } } : {}),
            ...(opts.hasMixins !== undefined ? { hasMixins: opts.hasMixins } : {}),
            ...(opts.decompiled !== undefined ? { decompiled: opts.decompiled } : {}),
        },
        orderBy: { ingestedAt: "desc" },
        take: opts.limit ?? 100,
    });
}

export async function getModDetails(modId: string | number): Promise<Mod | null> {
    if (typeof modId === "number") {
        return db().mod.findUnique({ where: { id: modId } });
    }
    // Try numeric id first
    const numeric = parseInt(modId, 10);
    if (!isNaN(numeric)) {
        const byId = await db().mod.findUnique({ where: { id: numeric } });
        if (byId) return byId;
    }
    // Fall back to mod_id string match
    return db().mod.findFirst({ where: { modId } });
}

export async function searchMods(query: string, opts?: {
    loader?: string;
    mcVersion?: string;
    limit?: number;
}): Promise<Mod[]> {
    const q = query.toLowerCase();
    return db().mod.findMany({
        where: {
            AND: [
                {
                    OR: [
                        { modId: { contains: q, mode: "insensitive" } },
                        { displayName: { contains: q, mode: "insensitive" } },
                        { metadata: { path: ["description"], string_contains: q } },
                    ],
                },
                ...(opts?.loader ? [{ loader: opts.loader }] : []),
                ...(opts?.mcVersion ? [{ mcVersion: { contains: opts.mcVersion } }] : []),
            ],
        },
        orderBy: { ingestedAt: "desc" },
        take: opts?.limit ?? 50,
    });
}

export async function getDbStats() {
    const [total, decompiled, loaderBreakdown, classCount, hasMixins, hasAt, hasAw] =
        await Promise.all([
            db().mod.count(),
            db().mod.count({ where: { decompiled: true } }),
            db().mod.groupBy({ by: ["loader"], _count: { id: true } }),
            db().modClass.count(),
            db().mod.count({ where: { hasMixins: true } }),
            db().mod.count({ where: { hasAt: true } }),
            db().mod.count({ where: { hasAw: true } }),
        ]);

    return {
        total,
        decompiled,
        notDecompiled: total - decompiled,
        hasMixins,
        hasAt,
        hasAw,
        indexedClasses: classCount,
        loaderBreakdown: Object.fromEntries(
            loaderBreakdown.map((r) => [r.loader, r._count.id])
        ),
    };
}

export async function getDependencies(modId: string | number, recursive = false) {
    const mod = await getModDetails(modId);
    if (!mod) throw new Error(`Mod not found: ${modId}`);

    type Dep = { id: string; version: string; required: boolean };
    const deps = mod.dependencies as Dep[];
    if (!recursive) {
        // Annotate each dep with whether it's present in the DB
        return deps.map((d) => ({ ...d, inDb: false })); // enriched below
    }

    // Recursive: resolve each dep from DB
    const seen = new Set<string>();
    const resolve = async (id: string): Promise<unknown[]> => {
        if (seen.has(id)) return [];
        seen.add(id);
        const dep = await db().mod.findFirst({ where: { modId: id } });
        if (!dep) return [];
        const subDeps = dep.dependencies as Array<{ id: string; }>;
        const children = await Promise.all(subDeps.map((d) => resolve(d.id)));
        return [{ ...dep, children: children.flat() }];
    };

    return Promise.all(deps.map((d) => resolve(d.id)));
}

/**
 * Detect version conflicts: multiple ingested versions of the same modId.
 * Also checks cross-mod dependency version range satisfaction.
 */
export async function findVersionConflicts(): Promise<object> {
    const mods = await db().mod.findMany({
        select: { id: true, modId: true, displayName: true, version: true, mcVersion: true, loader: true, dependencies: true },
        orderBy: [{ modId: "asc" }, { version: "asc" }],
    });

    // 1. Multiple ingested versions of the same modId
    const byModId: Record<string, typeof mods> = {};
    for (const m of mods) {
        (byModId[m.modId] ??= []).push(m);
    }
    const duplicates = Object.entries(byModId)
        .filter(([, versions]) => versions.length > 1)
        .map(([id, versions]) => ({
            modId: id,
            display: versions[0].displayName,
            ingestedVersions: versions.map((v) => ({ version: v.version, mcVersion: v.mcVersion, loader: v.loader, dbId: v.id })),
        }));

    // 2. Dependency version mismatches (mod declares dep but ingested version doesn't match range)
    type Dep = { id: string; version: string; required: boolean };
    const unsatisfied: Array<{ declaredBy: string; depId: string; requiredRange: string; foundVersions: string[]; required: boolean }> = [];

    for (const mod of mods) {
        const deps = mod.dependencies as Dep[];
        for (const dep of deps) {
            const found = byModId[dep.id];
            if (!found) continue; // not ingested — skip (not a conflict, just missing)
            const versions = found.map((m) => m.version);
            // Simple heuristic: if range contains "[" or "]" it's a maven range
            // Flag if no exact match and range looks specific
            const rangeIsSpecific = dep.version !== "*" && dep.version !== "" && dep.version !== "any";
            if (rangeIsSpecific && !versions.includes(dep.version.replace(/[\[\]()]/g, "").split(",")[0].trim())) {
                unsatisfied.push({
                    declaredBy:    mod.modId,
                    depId:         dep.id,
                    requiredRange: dep.version,
                    foundVersions: versions,
                    required:      dep.required,
                });
            }
        }
    }

    return {
        duplicateModIds: { count: duplicates.length, mods: duplicates },
        unsatisfiedDeps: { count: unsatisfied.length, deps: unsatisfied },
    };
}

/**
 * Build a full dependency graph across all ingested mods.
 * Returns adjacency list: modId → { requires: string[], requiredBy: string[] }
 */
export async function getDependencyGraph(mcVersion?: string): Promise<object> {
    const mods = await db().mod.findMany({
        where: mcVersion ? { mcVersion: { contains: mcVersion } } : undefined,
        select: { modId: true, displayName: true, version: true, loader: true, dependencies: true, metadata: true },
        orderBy: { modId: "asc" },
    });

    type Dep = { id: string; version: string; required: boolean };
    type Node = { display: string; version: string; loader: string; sourceUrl?: string; requires: Array<{ id: string; version: string; required: boolean; inDb: boolean }>; requiredBy: string[] };

    const knownIds = new Set(mods.map((m) => m.modId));
    const graph: Record<string, Node> = {};

    for (const mod of mods) {
        const deps = mod.dependencies as Dep[];
        graph[mod.modId] = {
            display:    mod.displayName,
            version:    mod.version,
            loader:     mod.loader,
            sourceUrl:  (mod.metadata as Record<string, string>)?.sourceUrl,
            requires:   deps.map((d) => ({ ...d, inDb: knownIds.has(d.id) })),
            requiredBy: [],
        };
    }

    // Back-fill requiredBy
    for (const mod of mods) {
        const deps = mod.dependencies as Dep[];
        for (const dep of deps) {
            if (graph[dep.id]) {
                graph[dep.id].requiredBy.push(mod.modId);
            }
        }
    }

    return { mcVersion: mcVersion ?? "all", modCount: mods.length, graph };
}

/**
 * Show source URLs for all ingested mods (extracted from JAR metadata at ingest time).
 */
export async function listModSourceUrls(query?: string): Promise<object> {
    const mods = await db().mod.findMany({
        where: query
            ? { OR: [{ modId: { contains: query, mode: "insensitive" } }, { displayName: { contains: query, mode: "insensitive" } }] }
            : undefined,
        select: { modId: true, displayName: true, version: true, loader: true, metadata: true },
        orderBy: { modId: "asc" },
    });

    const results = mods.map((m) => {
        const meta = m.metadata as Record<string, string> | null;
        return {
            modId:     m.modId,
            display:   m.displayName,
            version:   m.version,
            loader:    m.loader,
            sourceUrl: meta?.sourceUrl ?? null,
            modrinthSlug: meta?.modrinthSlug ?? null,
        };
    });

    const withSource = results.filter((r) => r.sourceUrl);
    return { total: results.length, withSourceUrl: withSource.length, mods: results };
}

