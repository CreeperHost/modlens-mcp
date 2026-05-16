import { extractEntry, listEntries } from "../jar.js";
import type { Mod } from "@prisma/client";
import {
    listMods as dbListMods,
    resolveModRef,
    searchModsFts,
    countMods,
    countAllModClasses,
    groupModsByLoader,
    findModByModId,
    listModsForConflictCheck,
    listModsForDepGraph,
    listModsForSourceUrls,
    resolveModRefSlim,
} from "../repositories/mod.js";

export async function listMods(opts: {
    loader?: string;
    mcVersion?: string;
    hasMixins?: boolean;
    decompiled?: boolean;
    limit?: number;
}): Promise<Mod[]> {
    return dbListMods(opts);
}

export async function getModDetails(modId: string | number): Promise<Mod | null> {
    return resolveModRef(modId);
}

export async function searchMods(query: string, opts?: {
    loader?: string;
    mcVersion?: string;
    limit?: number;
}): Promise<Mod[]> {
    return searchModsFts(query, opts);
}

export async function getDbStats() {
    const [total, decompiled, loaderBreakdown, classCount, hasMixins, hasAt, hasAw] =
        await Promise.all([
            countMods(),
            countMods({ decompiled: true }),
            groupModsByLoader(),
            countAllModClasses(),
            countMods({ hasMixins: true }),
            countMods({ hasAt: true }),
            countMods({ hasAw: true }),
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
        const dep = await findModByModId(id);
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
    const mods = await listModsForConflictCheck();

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
            const versionStr = typeof dep.version === "string" ? dep.version : String(dep.version ?? "");
            const rangeIsSpecific = versionStr !== "*" && versionStr !== "" && versionStr !== "any";
            if (rangeIsSpecific && !versions.includes(versionStr.replace(/[\[\]()]/g, "").split(",")[0].trim())) {
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
    const mods = await listModsForDepGraph(mcVersion);

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
    const mods = await listModsForSourceUrls(query);

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

// ── Mod registry listing via lang files ────────────────────────────────────────
// Lang keys follow the pattern <type>.<modid>.<name>, e.g. item.mymod.my_sword
// We read the JAR's lang file to enumerate what a mod registers.

type RegistryType =
    | "item" | "block" | "entity_type" | "enchantment" | "effect" | "biome"
    | "container" | "sound" | "potion" | "banner_pattern" | "painting"
    | "attribute" | "trim_material" | "trim_pattern" | "creative_tab"
    | "jukebox_song" | "death_message" | "fluid"
    | "all";

interface ModRegistryEntry {
    id: string;         // e.g. "mymod:my_sword"
    displayName: string; // from lang file
    langKey: string;    // raw key, e.g. "item.mymod.my_sword"
}

/** Read a mod's en_us.json and return registry entries filtered by type. */
export async function listModRegistryEntries(
    modId: string | number,
    type: RegistryType = "all",
    filter?: string,
    limit = 200,
): Promise<object> {
    // Resolve mod
    const mod = await resolveModRefSlim(modId);

    if (!mod) return { error: `Mod not found: ${modId}` };

    // Find lang file inside JAR — try common locations
    const langCandidates = [
        `assets/${mod.modId}/lang/en_us.json`,
        `assets/${mod.modId}/lang/en_US.json`,
    ];

    let lang: Record<string, string> | null = null;
    for (const path of langCandidates) {
        const buf = extractEntry(mod.jarPath, path);
        if (buf) {
            try { lang = JSON.parse(buf.toString("utf8")); break; } catch { /* skip */ }
        }
    }

    // Also try listing all lang files in case the modid folder differs
    if (!lang) {
        const allLang = listEntries(mod.jarPath, "assets/").filter(e => e.endsWith("/lang/en_us.json") || e.endsWith("/lang/en_US.json"));
        for (const path of allLang) {
            const buf = extractEntry(mod.jarPath, path);
            if (buf) {
                try { lang = JSON.parse(buf.toString("utf8")); break; } catch { /* skip */ }
            }
        }
    }

    if (!lang) {
        return { mod: mod.modId, error: "No en_us.json lang file found in JAR.", jarPath: mod.jarPath };
    }

    // Key prefixes for each type
    const PREFIX_MAP: Record<RegistryType, string[]> = {
        item:          ["item."],
        block:         ["block."],
        entity_type:   ["entity."],
        enchantment:   ["enchantment."],
        effect:        ["effect."],
        biome:         ["biome."],
        container:     ["container."],
        sound:         ["subtitles."],
        potion:        ["potion."],
        banner_pattern:["banner_pattern."],
        painting:      ["painting."],
        attribute:     ["attribute.name."],
        trim_material: ["trim_material."],
        trim_pattern:  ["trim_pattern."],
        creative_tab:  ["itemGroup."],
        jukebox_song:  ["jukebox_song."],
        death_message: ["death.attack."],
        fluid:         ["fluid.", "fluid_type."],
        all:           [],
    };

    const prefixes = PREFIX_MAP[type] ?? [];

    const entries: ModRegistryEntry[] = [];
    const filterLower = filter?.toLowerCase();

    for (const [key, value] of Object.entries(lang)) {
        // Type filter
        if (prefixes.length > 0 && !prefixes.some(p => key.startsWith(p))) continue;
        // Text filter
        if (filterLower && !key.toLowerCase().includes(filterLower) && !value.toLowerCase().includes(filterLower)) continue;

        // Convert lang key to registry id: "item.mymod.my_sword" → "mymod:my_sword"
        const parts = key.split(".");
        let registryId = key;
        if (parts.length >= 3) {
            // parts[0] = type prefix (item/block/entity/...)
            // parts[1] = namespace
            // parts[2..] = path (dots become underscores in registry, but keep as-is in id)
            registryId = `${parts[1]}:${parts.slice(2).join(".")}`;
        }

        entries.push({ id: registryId, displayName: value, langKey: key });
        if (entries.length >= limit) break;
    }

    return {
        mod: mod.modId,
        displayName: mod.displayName,
        version: mod.version,
        type,
        filter: filter ?? "(none)",
        count: entries.length,
        note: entries.length === limit ? `Results capped at ${limit}. Use filter to narrow.` : undefined,
        entries,
    };
}

