/**
 * Repository layer for the Mod, ModClass, and ModTag tables.
 * All Prisma queries against these tables live here.
 * Tool files import from this module instead of calling db() directly.
 */
import { db } from "../db.js";
import type { Mod, Prisma } from "@prisma/client";

// ── Projections ───────────────────────────────────────────────────────────────

/** Minimal projection used in class-analysis and scan operations. */
export type ModRef = {
    id: number; modId: string; displayName: string; version: string; jarPath: string;
    loader: string; mcVersion: string;
};

/** Projection for mixin-scan operations. */
export type MixinModRow = {
    id: number; modId: string; displayName: string; version: string;
    mcVersion: string; loader: string; mixinTargets: unknown; mixinConfigs: string[];
};

/** Projection for version-conflict and dep-graph operations. */
export type DepModRow = {
    id: number; modId: string; displayName: string; version: string;
    mcVersion: string; loader: string; dependencies: unknown; metadata: unknown;
};

/** Projection for batch platform-sync operations. */
export type SyncModRow = {
    id: number; modId: string; version: string;
    sha512: string | null; murmur2: string | null;
    modrinthId: string | null; curseforgeId: number | null;
    sourcePath: string | null; metadata: unknown;
};

// ── Mod queries ───────────────────────────────────────────────────────────────

export async function findModById(id: number): Promise<Mod | null> {
    return db().mod.findUnique({ where: { id } });
}

export async function findModByJarPath(jarPath: string): Promise<Mod | null> {
    return db().mod.findUnique({ where: { jarPath } });
}

export async function findModByModId(modId: string): Promise<Mod | null> {
    return db().mod.findFirst({ where: { modId } });
}

export async function findModByModIdLike(modId: string): Promise<Mod | null> {
    return db().mod.findFirst({ where: { modId: { contains: modId } } });
}

/** Resolve mod by string or number. Numeric strings try findById first. */
export async function resolveModRef(ref: string | number): Promise<Mod | null> {
    if (typeof ref === "number") return findModById(ref);
    const n = parseInt(ref, 10);
    if (!isNaN(n)) {
        const byId = await findModById(n);
        if (byId) return byId;
    }
    return findModByModId(ref);
}

/** Slim resolveModRef — returns only id, modId, displayName, version, jarPath. */
export async function resolveModRefSlim(ref: string | number): Promise<ModRef | null> {
    const sel = { id: true, modId: true, displayName: true, version: true, jarPath: true, loader: true, mcVersion: true } as const;
    if (typeof ref === "number") {
        return db().mod.findUnique({ where: { id: ref }, select: sel });
    }
    const n = parseInt(String(ref), 10);
    if (!isNaN(n)) {
        const byId = await db().mod.findUnique({ where: { id: n }, select: sel });
        if (byId) return byId;
    }
    return db().mod.findFirst({ where: { modId: { contains: String(ref) } }, select: sel });
}

export async function findModByDupKey(
    modId: string, version: string, mcVersion: string, loader: string,
): Promise<Mod | null> {
    return db().mod.findFirst({ where: { modId, version, mcVersion, loader } });
}

export async function findModBySha512(sha512: string): Promise<Mod | null> {
    return db().mod.findFirst({ where: { sha512 } });
}

export async function listAllMods(): Promise<Mod[]> {
    return db().mod.findMany({ orderBy: { id: "asc" } });
}

export async function findModsByIds(ids: number[]): Promise<Mod[]> {
    return db().mod.findMany({ where: { id: { in: ids } } });
}

/**
 * Returns conflict data pre-aggregated in SQL using jsonb_array_elements_text.
 * Each row: class name + count of mods targeting it + array of mod IDs.
 * Only returns classes targeted by >= minConflicts mods.
 */
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


export async function listMods(opts: {
    loader?: string; mcVersion?: string; hasMixins?: boolean;
    decompiled?: boolean; limit?: number; modIdFilter?: string;
}): Promise<Mod[]> {
    return db().mod.findMany({
        where: {
            ...(opts.loader ? { loader: opts.loader } : {}),
            ...(opts.mcVersion ? { mcVersion: { contains: opts.mcVersion } } : {}),
            ...(opts.hasMixins !== undefined ? { hasMixins: opts.hasMixins } : {}),
            ...(opts.decompiled !== undefined ? { decompiled: opts.decompiled } : {}),
            ...(opts.modIdFilter ? { modId: { contains: opts.modIdFilter, mode: "insensitive" as const } } : {}),
        },
        orderBy: { ingestedAt: "desc" },
        take: opts.limit ?? 100,
    });
}

export async function listModsSlim(opts?: {
    loader?: string; mcVersion?: string; hasMixins?: boolean;
    decompiled?: boolean; modIdFilter?: string;
}): Promise<ModRef[]> {
    return db().mod.findMany({
        where: {
            ...(opts?.loader ? { loader: opts.loader } : {}),
            ...(opts?.mcVersion ? { mcVersion: { contains: opts.mcVersion } } : {}),
            ...(opts?.hasMixins !== undefined ? { hasMixins: opts.hasMixins } : {}),
            ...(opts?.decompiled !== undefined ? { decompiled: opts.decompiled } : {}),
            ...(opts?.modIdFilter ? { modId: { contains: opts.modIdFilter } } : {}),
        },
        select: { id: true, modId: true, displayName: true, version: true, jarPath: true, loader: true, mcVersion: true },
    });
}

export async function listModsForMixinScan(opts?: {
    hasMixins?: boolean; loader?: string; mcVersion?: string;
}): Promise<MixinModRow[]> {
    return db().mod.findMany({
        where: {
            ...(opts?.hasMixins !== undefined ? { hasMixins: opts.hasMixins } : {}),
            ...(opts?.loader ? { loader: opts.loader } : {}),
            ...(opts?.mcVersion ? { mcVersion: { contains: opts.mcVersion } } : {}),
        },
        select: {
            id: true, modId: true, displayName: true, version: true,
            mcVersion: true, loader: true, mixinTargets: true, mixinConfigs: true,
        },
        orderBy: { modId: "asc" },
    }) as Promise<MixinModRow[]>;
}

export async function listModsForDepGraph(mcVersion?: string): Promise<DepModRow[]> {
    return db().mod.findMany({
        where: mcVersion ? { mcVersion: { contains: mcVersion } } : undefined,
        select: {
            id: true, modId: true, displayName: true, version: true,
            mcVersion: true, loader: true, dependencies: true, metadata: true,
        },
        orderBy: { modId: "asc" },
    }) as Promise<DepModRow[]>;
}

export async function listModsForConflictCheck(): Promise<DepModRow[]> {
    return db().mod.findMany({
        select: {
            id: true, modId: true, displayName: true, version: true,
            mcVersion: true, loader: true, dependencies: true, metadata: true,
        },
        orderBy: [{ modId: "asc" }, { version: "asc" }],
    }) as Promise<DepModRow[]>;
}

export async function listModsForSync(opts?: {
    modIdFilter?: string; limit?: number;
}): Promise<SyncModRow[]> {
    return db().mod.findMany({
        where: opts?.modIdFilter ? { modId: { contains: opts.modIdFilter } } : {},
        select: {
            id: true, modId: true, version: true,
            sha512: true, murmur2: true,
            modrinthId: true, curseforgeId: true,
            sourcePath: true, metadata: true,
        },
        orderBy: { id: "asc" },
        take: opts?.limit ?? 500,
    }) as Promise<SyncModRow[]>;
}

export async function countMods(where?: Prisma.ModWhereInput): Promise<number> {
    return db().mod.count({ where });
}

export async function groupModsByLoader() {
    return db().mod.groupBy({ by: ["loader"], _count: { id: true } });
}

export async function searchModsFts(query: string, opts?: {
    loader?: string; mcVersion?: string; limit?: number;
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

export async function listModsForSourceUrls(query?: string) {
    return db().mod.findMany({
        where: query
            ? { OR: [{ modId: { contains: query, mode: "insensitive" } }, { displayName: { contains: query, mode: "insensitive" } }] }
            : undefined,
        select: { modId: true, displayName: true, version: true, loader: true, metadata: true },
        orderBy: { modId: "asc" },
    });
}

export async function createMod(data: Prisma.ModCreateInput): Promise<Mod> {
    return db().mod.create({ data });
}

export async function updateMod(id: number, data: Prisma.ModUpdateInput): Promise<Mod> {
    return db().mod.update({ where: { id }, data });
}

export async function getModMetadata(id: number): Promise<{ metadata: unknown } | null> {
    return db().mod.findUnique({ where: { id }, select: { metadata: true } });
}

// ── ModClass queries ──────────────────────────────────────────────────────────

export async function countAllModClasses(): Promise<number> {
    return db().modClass.count();
}

export async function countModClasses(modId: number): Promise<number> {
    return db().modClass.count({ where: { modId } });
}

export async function createModClasses(data: Prisma.ModClassCreateManyInput[]): Promise<void> {
    await db().modClass.createMany({ data, skipDuplicates: true });
}

export async function findModClassesForCrossModSearch(
    where1: Prisma.ModClassWhereInput,
    where2: Prisma.ModClassWhereInput,
    limit: number,
) {
    const sel = { mod: { select: { modId: true, displayName: true, version: true } } } as const;
    return Promise.all([
        db().modClass.findMany({ where: where1, include: sel, take: limit }),
        db().modClass.findMany({ where: where2, include: sel, take: limit }),
    ]);
}

// ── ModTag queries ────────────────────────────────────────────────────────────

export async function deleteModTags(modId: number): Promise<void> {
    await db().modTag.deleteMany({ where: { modId } });
}

export async function createModTags(data: Prisma.ModTagCreateManyInput[]): Promise<void> {
    await db().modTag.createMany({ data });
}

export async function findModTagsByPath(tagPath: string, registry?: string) {
    return db().modTag.findMany({
        where: {
            tagPath: tagPath.replace(/^#/, ""),
            ...(registry ? { registry } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true, version: true, mcVersion: true, loader: true } } },
    });
}

export async function findModTagsByMod(modId: number, registry?: string) {
    return db().modTag.findMany({
        where: { modId, ...(registry ? { registry } : {}) },
        orderBy: [{ registry: "asc" }, { tagPath: "asc" }],
    });
}

export async function findAllModTagsByPath(tagPath: string, registry?: string) {
    return db().modTag.findMany({
        where: {
            tagPath: tagPath.replace(/^#/, ""),
            ...(registry ? { registry } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true } } },
    });
}

export async function findReplaceModTags(registry?: string) {
    return db().modTag.findMany({
        where: { replace: true, ...(registry ? { registry } : {}) },
        include: { mod: { select: { modId: true, displayName: true, version: true } } },
        orderBy: [{ tagPath: "asc" }, { registry: "asc" }],
    });
}

export async function searchModTagsByPath(query: string, registry?: string, limit = 50) {
    return db().modTag.findMany({
        where: {
            tagPath: { contains: query, mode: "insensitive" },
            ...(registry ? { registry } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true, version: true } } },
        distinct: ["tagPath", "registry"],
        orderBy: [{ tagPath: "asc" }, { registry: "asc" }],
        take: limit,
    });
}

export async function listModTagNamespaces() {
    const rows = await db().modTag.findMany({
        select: { registry: true, namespace: true },
        distinct: ["registry", "namespace"],
        orderBy: [{ registry: "asc" }, { namespace: "asc" }],
    });
    return rows;
}
