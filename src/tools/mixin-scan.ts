/**
 * Cross-mod mixin scanner.
 *
 * Tools for seeing the full mixin picture across all ingested mods:
 *   - List every mod that has mixins (without having to call getMixinTargets per mod)
 *   - Full conflict matrix: for each class, every mod that mixes into it
 *   - Summary: most-contested classes, mods with the most mixins, etc.
 */
import { listModsForMixinScan, listModsSlim, findModsByIds, findModById, findModByModId, updateMod, listMods } from "../repositories/mod.js";
import { getDb } from "../db.js";
import { getBytecode } from "../java-tools.js";
import AdmZip from "adm-zip";

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

// ── Mixin target resolution (from bytecode) ───────────────────────────────────

function parseMixinTargetsFromJavap(output: string): string[] {
    const targets: string[] = [];

    // Locate the @Mixin annotation block in javap -verbose output
    const annotationIdx = output.indexOf("org.spongepowered.asm.mixin.Mixin(");
    if (annotationIdx === -1) return targets;

    // Grab a reasonable chunk after the annotation name
    const block = output.slice(annotationIdx, annotationIdx + 2000);

    /** Normalise a raw class token to internal slash-separated form, stripping
     *  bytecode descriptor prefix/suffix (e.g. "Lnet/minecraft/X;" → "net/minecraft/X"). */
    function normalise(raw: string): string {
        let s = raw;
        // Strip leading 'L' and trailing ';' (bytecode descriptor)
        if (s.startsWith("L") && s.endsWith(";")) s = s.slice(1, -1);
        else if (s.startsWith("L") && s.includes("/")) s = s.slice(1);
        // Dot-notation → slash-notation
        if (!s.includes("/")) s = s.replace(/\./g, "/");
        return s;
    }

    // value=[class net.minecraft.X] or value=[class net/minecraft/X] or value=[class Lnet/minecraft/X;]
    // Allow slashes and semicolons in addition to word chars and dots
    for (const m of block.matchAll(/class\s+([\w.$\\/;]+)/g)) {
        const cls = normalise(m[1]);
        if (cls.includes("/") && !targets.includes(cls)) targets.push(cls);
    }

    // targets=["net/minecraft/X"] or targets={"net/minecraft/X"}  (slash-separated strings)
    for (const m of block.matchAll(/"([\w/$]+)"/g)) {
        const cls = m[1];
        if (cls.includes("/") && !targets.includes(cls)) targets.push(cls);
    }

    return targets;
}

/** Read mixin class names fresh from the JAR's mixin config JSON files. */
function readMixinClassesFromJar(jarPath: string, mixinConfigs: string[]): string[] {
    const zip = new AdmZip(jarPath);
    const classes: string[] = [];
    for (const cfg of mixinConfigs) {
        const entry = zip.getEntry(cfg);
        if (!entry) continue;
        try {
            const json = JSON.parse(zip.readFile(entry)!.toString("utf8")) as {
                package?: string;
                mixins?: string[];
                client?: string[];
                server?: string[];
            };
            const pkg = json.package ? json.package + "." : "";
            const all = [...(json.mixins ?? []), ...(json.client ?? []), ...(json.server ?? [])];
            classes.push(...all.map((c) => pkg + c));
        } catch { /* malformed — skip */ }
    }
    return classes;
}

export async function resolveMixinTargets(dbId: number): Promise<{
    resolved: number; failed: number; skipped: number; targets: string[];
}> {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    // Always re-read mixin class names from the JAR — never from DB mixinTargets
    // (DB value may already be resolved or stale)
    const mixinClasses = readMixinClassesFromJar(mod.jarPath, mod.mixinConfigs as string[]);
    if (!mixinClasses.length) return { resolved: 0, failed: 0, skipped: 0, targets: [] };

    const allTargets = new Set<string>();
    let resolved = 0, failed = 0, skipped = 0;

    for (const mixinClass of mixinClasses) {
        const className = mixinClass.replace(/\./g, "/");
        try {
            const bytecode = await getBytecode(mod.jarPath, className);
            const targets = parseMixinTargetsFromJavap(bytecode);
            if (targets.length === 0) { skipped++; continue; }
            targets.forEach((t) => allTargets.add(t));
            resolved++;
        } catch {
            failed++;
        }
    }

    const targetArray = [...allTargets];
    await updateMod(dbId, { mixinTargets: targetArray });

    return { resolved, failed, skipped, targets: targetArray };
}

export async function getMixinTargets(modId: string | number) {
    let mod;
    if (typeof modId === "number" || !isNaN(parseInt(String(modId), 10))) {
        mod = await findModById(Number(modId));
    }
    if (!mod) mod = await findModByModId(String(modId));
    if (!mod) throw new Error(`Mod not found: ${modId}`);

    return {
        modId: mod.modId,
        displayName: mod.displayName,
        mixinConfigs: mod.mixinConfigs,
        mixinTargets: mod.mixinTargets,
    };
}

export async function getMixinConflicts(targetClass: string) {
    const all = await listMods({ hasMixins: true, limit: 9999 });
    const mods = all.filter((m) => (m.mixinTargets as string[])?.includes(targetClass));

    return {
        targetClass,
        conflictingMods: mods,
        count: mods.length,
    };
}

export async function getAtEntries(dbId: number) {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    return {
        modId: mod.modId,
        hasAt: mod.hasAt,
        atEntries: mod.atEntries,
    };
}

export async function getAwEntries(dbId: number) {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    return {
        modId: mod.modId,
        hasAw: mod.hasAw,
        awEntries: mod.awEntries,
    };
}

/**
 * Find all mods whose mixinTargets contain a class in the given package (or subpackage).
 * packagePrefix: slash-separated, e.g. "net/minecraft/world/level" or "net/minecraft/world/entity"
 * mcVersion: optional filter
 */
export async function getMixinsTargetingPackage(packagePrefix: string, mcVersion?: string) {
    const prefix = packagePrefix.replace(/\./g, "/").replace(/\/$/, "");

    const mods = await listMods({
        hasMixins: true,
        mcVersion,
    });

    const results: Array<{ modId: string; displayName: string; version: string; mcVersion: string; loader: string; matchingTargets: string[] }> = [];

    for (const mod of mods) {
        const targets = mod.mixinTargets as string[];
        const matching = targets.filter(t => t === prefix || t.startsWith(prefix + "/"));
        if (matching.length > 0) {
            results.push({
                modId: mod.modId,
                displayName: mod.displayName,
                version: mod.version,
                mcVersion: mod.mcVersion,
                loader: mod.loader,
                matchingTargets: matching,
            });
        }
    }

    return {
        packagePrefix: prefix,
        mcVersion: mcVersion ?? "(all)",
        totalMods: results.length,
        totalTargets: results.reduce((n, r) => n + r.matchingTargets.length, 0),
        mods: results,
    };
}

// ── AT/AW conflict detection ───────────────────────────────────────────────────

/**
 * Find Access Transformer / Access Widener entries where two or more mods
 * target the same class member. Returns entries grouped by target signature so
 * you can see at a glance who's AT-ing what.
 *
 * mcVersion: optional filter
 * loader: optional filter ("neoforge" | "forge" | "fabric" | "quilt")
 */
export async function findAtAwConflicts(mcVersion?: string, loader?: string): Promise<object> {
    const mods = await listMods({
        ...(mcVersion ? { mcVersion } : {}),
        ...(loader ? { loader } : {}),
    });

    // Deduplicate by modId — keep highest DB id (most recently ingested version)
    const dedupedMods = [...mods
        .sort((a, b) => b.id - a.id)
        .reduce((m, mod) => { if (!m.has(mod.modId)) m.set(mod.modId, mod); return m; }, new Map<string, typeof mods[0]>())
        .values()];

    // Map: canonical target signature → [{mod, access}]
    const atMap = new Map<string, Array<{ mod: string; display: string; version: string; loader: string; access: string }>>();

    for (const mod of dedupedMods) {
        const addEntry = (sig: string, access: string) => {
            if (!atMap.has(sig)) atMap.set(sig, []);
            atMap.get(sig)!.push({ mod: mod.modId, display: mod.displayName, version: mod.version, loader: mod.loader, access });
        };

        // AT entries: "accessible method net/minecraft/Foo bar (I)V"
        for (const entry of (mod.atEntries as string[]) ?? []) {
            const clean = (typeof entry === "string" ? entry : JSON.stringify(entry)).trim();
            // Canonical signature = everything after the access modifier word
            const parts = clean.split(/\s+/);
            if (parts.length >= 2) {
                const sig = parts.slice(1).join(" ");
                addEntry(`AT:${sig}`, parts[0]);
            }
        }

        // AW entries: "accessible class net/minecraft/Foo" or "accessible method net/minecraft/Foo bar (I)V"
        for (const entry of (mod.awEntries as string[]) ?? []) {
            const clean = (typeof entry === "string" ? entry : JSON.stringify(entry)).trim();
            const parts = clean.split(/\s+/);
            if (parts.length >= 2) {
                const sig = parts.slice(1).join(" ");
                addEntry(`AW:${sig}`, parts[0]);
            }
        }
    }

    const conflicts = [...atMap.entries()]
        .filter(([, users]) => users.length >= 2)
        .map(([sig, users]) => {
            const accessValues = new Set(users.map(u => u.access));
            return { target: sig, modCount: users.length, accessConflict: accessValues.size > 1, users };
        })
        .sort((a, b) => b.modCount - a.modCount);

    const accessConflicts = conflicts.filter(c => c.accessConflict);
    const sharedTargets   = conflicts.filter(c => !c.accessConflict);

    return {
        mcVersion: mcVersion ?? "(all)",
        loader: loader ?? "(all)",
        totalModsWithAt: dedupedMods.filter(m => m.hasAt).length,
        totalModsWithAw: dedupedMods.filter(m => m.hasAw).length,
        summary: {
            sharedTargets: sharedTargets.length,
            accessConflicts: accessConflicts.length,
        },
        note: accessConflicts.length > 0
            ? "accessConflict=true means mods target the same member but request different access levels — last-loaded wins."
            : "No access-level conflicts found; all shared targets request the same access.",
        accessConflicts,
        sharedTargets,
    };
}
