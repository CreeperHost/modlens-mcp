/**
 * Repository layer for the Mod, ModClass, and ModTag tables.
 * All Prisma queries against these tables live here.
 * Tool files import from this module instead of calling db() directly.
 */
import { getDb } from "../db.js";
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
    const db = await getDb();
    return db.mod.findUnique({ where: { id } });
}

export async function findModByJarPath(jarPath: string): Promise<Mod | null> {
    const db = await getDb();
    return db.mod.findUnique({ where: { jarPath } });
}

export async function findModByModId(modId: string): Promise<Mod | null> {
    const db = await getDb();
    return db.mod.findFirst({ where: { modId } });
}

export async function findModByModIdLike(modId: string): Promise<Mod | null> {
    const db = await getDb();
    return db.mod.findFirst({ where: { modId: { contains: modId } } });
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
    const db = await getDb();
    if (typeof ref === "number") {
        return db.mod.findUnique({ where: { id: ref }, select: sel });
    }
    const n = parseInt(String(ref), 10);
    if (!isNaN(n)) {
        const byId = await db.mod.findUnique({ where: { id: n }, select: sel });
        if (byId) return byId;
    }
    return db.mod.findFirst({ where: { modId: { contains: String(ref) } }, select: sel });
}

export async function findModByDupKey(
    modId: string, version: string, mcVersion: string, loader: string,
): Promise<Mod | null> {
    const db = await getDb();
    return db.mod.findFirst({ where: { modId, version, mcVersion, loader } });
}

export async function findModBySha512(sha512: string): Promise<Mod | null> {
    const db = await getDb();
    return db.mod.findFirst({ where: { sha512 } });
}

export async function listAllMods(): Promise<Mod[]> {
    const db = await getDb();
    return db.mod.findMany({ orderBy: { id: "asc" } });
}

export async function findModsByIds(ids: number[]): Promise<Mod[]> {
    const db = await getDb();
    return db.mod.findMany({ where: { id: { in: ids } } });
}


export async function listMods(opts: {
    loader?: string; mcVersion?: string; hasMixins?: boolean;
    decompiled?: boolean; limit?: number; modIdFilter?: string;
}): Promise<Mod[]> {
    const db = await getDb();
    return db.mod.findMany({
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
    const db = await getDb();
    return db.mod.findMany({
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
    const db = await getDb();
    return db.mod.findMany({
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
    const db = await getDb();
    return db.mod.findMany({
        where: mcVersion ? { mcVersion: { contains: mcVersion } } : undefined,
        select: {
            id: true, modId: true, displayName: true, version: true,
            mcVersion: true, loader: true, dependencies: true, metadata: true,
        },
        orderBy: { modId: "asc" },
    }) as Promise<DepModRow[]>;
}

export async function listModsForConflictCheck(opts?: { mcVersion?: string; loader?: string }): Promise<DepModRow[]> {
    const where: Record<string, unknown> = {};
    if (opts?.mcVersion) where["mcVersion"] = opts.mcVersion;
    if (opts?.loader)    where["loader"]    = opts.loader;
    const db = await getDb();
    return db.mod.findMany({
        where,
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
    const db = await getDb();
    return db.mod.findMany({
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
    const db = await getDb();
    return db.mod.count({ where });
}

export async function groupModsByLoader() {
    const db = await getDb();
    return db.mod.groupBy({ by: ["loader"], _count: { id: true } });
}

export async function searchModsFts(query: string, opts?: {
    loader?: string; mcVersion?: string; limit?: number;
}): Promise<Mod[]> {
    const q = query.toLowerCase();
    const db = await getDb();
    return db.mod.findMany({
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
    const db = await getDb();
    return db.mod.findMany({
        where: query
            ? { OR: [{ modId: { contains: query, mode: "insensitive" } }, { displayName: { contains: query, mode: "insensitive" } }] }
            : undefined,
        select: { modId: true, displayName: true, version: true, loader: true, metadata: true },
        orderBy: { modId: "asc" },
    });
}

export async function createMod(data: Prisma.ModCreateInput): Promise<Mod> {
    const db = await getDb();
    return db.mod.create({ data });
}

export async function updateMod(id: number, data: Prisma.ModUpdateInput): Promise<Mod> {
    const db = await getDb();
    return db.mod.update({ where: { id }, data });
}

export async function getModMetadata(id: number): Promise<{ metadata: unknown } | null> {
    const db = await getDb();
    return db.mod.findUnique({ where: { id }, select: { metadata: true } });
}

// ── ModClass queries ──────────────────────────────────────────────────────────

export async function countAllModClasses(): Promise<number> {
    const db = await getDb();
    return db.modClass.count();
}

export async function countModClasses(modId: number): Promise<number> {
    const db = await getDb();
    return db.modClass.count({ where: { modId } });
}

export async function createModClasses(data: Prisma.ModClassCreateManyInput[]): Promise<void> {
    const db = await getDb();
    await db.modClass.createMany({ data, skipDuplicates: true });
}

export async function findModClassesForCrossModSearch(
    where1: Prisma.ModClassWhereInput,
    where2: Prisma.ModClassWhereInput,
    limit: number,
) {
    const db = await getDb();
    const sel = { mod: { select: { modId: true, displayName: true, version: true } } } as const;
    return Promise.all([
        db.modClass.findMany({ where: where1, include: sel, take: limit }),
        db.modClass.findMany({ where: where2, include: sel, take: limit }),
    ]);
}

/**
 * Bulk-lookup: given a list of class names (slash-form), return all ModClass
 * rows with their parent mod info. Used by analyzeCrashLog.
 */
export async function findModClassesByClassNames(
    classNames: string[],
): Promise<Array<{ className: string; modId: number; mod: { modId: string; displayName: string } }>> {
    if (classNames.length === 0) return [];
    const db = await getDb();
    return db.modClass.findMany({
        where: { className: { in: classNames } },
        select: {
            className: true,
            modId: true,
            mod: { select: { modId: true, displayName: true } },
        },
    }) as Promise<Array<{ className: string; modId: number; mod: { modId: string; displayName: string } }>>;
}

// ── ModTag queries ────────────────────────────────────────────────────────────

export async function deleteModById(id: number): Promise<void> {
    // ModClass rows are cascade-deleted by the DB foreign key; ModTag rows are not, delete manually
    const db = await getDb();
    await db.modTag.deleteMany({ where: { modId: id } });
    await db.modClass.deleteMany({ where: { modId: id } });
    await db.mod.delete({ where: { id } });
}

export async function deleteModTags(modId: number): Promise<void> {
    const db = await getDb();
    await db.modTag.deleteMany({ where: { modId } });
}

export async function createModTags(data: Prisma.ModTagCreateManyInput[]): Promise<void> {
    const db = await getDb();
    await db.modTag.createMany({ data });
}

export async function findModTagsByPath(tagPath: string, registry?: string) {
    const db = await getDb();
    return db.modTag.findMany({
        where: {
            tagPath: tagPath.replace(/^#/, ""),
            ...(registry ? { registry } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true, version: true, mcVersion: true, loader: true } } },
    });
}

export async function findModTagsByMod(modId: number, registry?: string) {
    const db = await getDb();
    return db.modTag.findMany({
        where: { modId, ...(registry ? { registry } : {}) },
        orderBy: [{ registry: "asc" }, { tagPath: "asc" }],
    });
}

export async function findAllModTagsByPath(tagPath: string, registry?: string) {
    const db = await getDb();
    return db.modTag.findMany({
        where: {
            tagPath: tagPath.replace(/^#/, ""),
            ...(registry ? { registry } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true } } },
    });
}

export async function findReplaceModTags(registry?: string) {
    const db = await getDb();
    return db.modTag.findMany({
        where: { replace: true, ...(registry ? { registry } : {}) },
        include: { mod: { select: { modId: true, displayName: true, version: true } } },
        orderBy: [{ tagPath: "asc" }, { registry: "asc" }],
    });
}

export async function searchModTagsByPath(query: string, registry?: string, limit = 50) {
    const db = await getDb();
    return db.modTag.findMany({
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
    const db = await getDb();
    const rows = await db.modTag.findMany({
        select: { registry: true, namespace: true },
        distinct: ["registry", "namespace"],
        orderBy: [{ registry: "asc" }, { namespace: "asc" }],
    });
    return rows;
}
