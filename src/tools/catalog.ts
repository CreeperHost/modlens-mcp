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

    const deps = mod.dependencies as Array<{ id: string; version: string; required: boolean; }>;
    if (!recursive) return deps;

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
