/**
 * Mod-shipped tag indexer and query tools.
 *
 * Scans a mod JAR for data/<namespace>/tags/<registry>/<...>.json files,
 * stores them in the mod_tags table, and exposes cross-mod query tools:
 *   - "what mods contribute to #c:ores/iron?"
 *   - "what tags does Mekanism register?"
 *   - "which tag paths have a replace:true conflict?"
 */
import AdmZip from "adm-zip";
import { db } from "../db.js";

// ── JAR scanner ───────────────────────────────────────────────────────────────

interface ScannedTag {
    registry:  string;
    tagPath:   string;   // namespace:subpath
    namespace: string;
    entries:   string[];
    replace:   boolean;
}

/**
 * Read all data/<ns>/tags/<registry>/... JSON files from a JAR and return
 * structured tag records.
 */
function scanTagsFromJar(jarPath: string): ScannedTag[] {
    const zip = new AdmZip(jarPath);
    const results: ScannedTag[] = [];

    for (const entry of zip.getEntries()) {
        const name = entry.entryName;
        // data/<namespace>/tags/<registry>/[<subdir>/]<file>.json
        const m = name.match(/^data\/([^/]+)\/tags\/([^/]+)\/(.+)\.json$/);
        if (!m) continue;
        const [, ns, registry, subpath] = m;

        let json: { values?: unknown[]; replace?: boolean } = {};
        try {
            json = JSON.parse(zip.readFile(entry)!.toString("utf8"));
        } catch { continue; }

        const rawValues = json.values ?? [];
        const entries: string[] = rawValues.map((v) => {
            if (typeof v === "string") return v;
            if (typeof v === "object" && v !== null && "id" in v) return String((v as { id: unknown }).id);
            return String(v);
        });

        results.push({
            registry,
            tagPath:   `${ns}:${subpath}`,
            namespace: ns,
            entries,
            replace:   json.replace === true,
        });
    }
    return results;
}

// ── Public tools ──────────────────────────────────────────────────────────────

/**
 * Index all tag files from a mod JAR into the mod_tags table.
 * Safe to re-run — deletes existing rows for this mod first (full re-index).
 */
export async function indexModTags(modIdOrDbId: string | number): Promise<object> {
    const mod = typeof modIdOrDbId === "number" || !isNaN(Number(modIdOrDbId))
        ? await db().mod.findUnique({ where: { id: Number(modIdOrDbId) } })
        : await db().mod.findFirst({ where: { modId: String(modIdOrDbId) } });
    if (!mod) return { error: `Mod not found: ${modIdOrDbId}` };

    const scanned = scanTagsFromJar(mod.jarPath);

    // Full re-index
    await db().modTag.deleteMany({ where: { modId: mod.id } });

    if (scanned.length > 0) {
        await db().modTag.createMany({
            data: scanned.map((t) => ({
                modId:     mod.id,
                registry:  t.registry,
                tagPath:   t.tagPath,
                namespace: t.namespace,
                entries:   t.entries,
                replace:   t.replace,
            })),
        });
    }

    return {
        mod:      mod.modId,
        version:  mod.version,
        indexed:  scanned.length,
        replaceCount: scanned.filter((t) => t.replace).length,
        registries: [...new Set(scanned.map((t) => t.registry))],
    };
}

/**
 * Index tags for ALL ingested mods.
 * Returns a summary per mod.
 */
export async function indexAllModTags(): Promise<object> {
    const mods = await db().mod.findMany({ select: { id: true, modId: true, version: true } });
    const results: Array<{ mod: string; version: string; indexed: number; error?: string }> = [];

    for (const mod of mods) {
        try {
            const r = await indexModTags(mod.id) as { indexed: number };
            results.push({ mod: mod.modId, version: mod.version, indexed: r.indexed });
        } catch (e) {
            results.push({ mod: mod.modId, version: mod.version, indexed: 0, error: String(e) });
        }
    }

    const total = results.reduce((s, r) => s + r.indexed, 0);
    return { modsProcessed: mods.length, totalTagsIndexed: total, results };
}

/**
 * List all tag namespaces + registries present in the DB across all mods.
 * Useful for discovering what tag namespaces mods use (minecraft, c, forge, neoforge, mymod, …).
 */
export async function listTagNamespaces(): Promise<object> {
    const rows = await db().modTag.findMany({
        select: { namespace: true, registry: true },
        distinct: ["namespace", "registry"],
        orderBy: [{ namespace: "asc" }, { registry: "asc" }],
    });

    // Group by namespace
    const byNs: Record<string, string[]> = {};
    for (const r of rows) {
        (byNs[r.namespace] ??= []).push(r.registry);
    }
    return { count: rows.length, namespaces: byNs };
}

/**
 * Get all mods that contribute to a specific tag path.
 * tagPath: e.g. "c:ores/iron", "forge:storage_blocks", "minecraft:logs"
 */
export async function getTagContributors(tagPath: string, registry?: string): Promise<object> {
    const normalPath = tagPath.startsWith("#") ? tagPath.slice(1) : tagPath;

    const rows = await db().modTag.findMany({
        where: {
            tagPath: normalPath,
            ...(registry ? { registry } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true, version: true, mcVersion: true, loader: true } } },
        orderBy: { mod: { modId: "asc" } },
    });

    return {
        tagPath: `#${normalPath}`,
        registry: registry ?? rows[0]?.registry ?? "?",
        contributorCount: rows.length,
        hasReplaceConflict: rows.filter((r) => r.replace).length > 1,
        contributors: rows.map((r) => ({
            mod:      r.mod.modId,
            display:  r.mod.displayName,
            version:  r.mod.version,
            loader:   r.mod.loader,
            replace:  r.replace,
            entries:  r.entries,
        })),
    };
}

/**
 * List all tags registered by a specific mod.
 * Optionally filter by registry.
 */
export async function getModTagList(modIdOrDbId: string | number, registry?: string): Promise<object> {
    const mod = typeof modIdOrDbId === "number" || !isNaN(Number(modIdOrDbId))
        ? await db().mod.findUnique({ where: { id: Number(modIdOrDbId) } })
        : await db().mod.findFirst({ where: { modId: String(modIdOrDbId) } });
    if (!mod) return { error: `Mod not found: ${modIdOrDbId}` };

    const rows = await db().modTag.findMany({
        where: { modId: mod.id, ...(registry ? { registry } : {}) },
        orderBy: [{ registry: "asc" }, { tagPath: "asc" }],
    });

    return {
        mod:     mod.modId,
        version: mod.version,
        count:   rows.length,
        tags: rows.map((r) => ({
            registry: r.registry,
            tagPath:  `#${r.tagPath}`,
            replace:  r.replace,
            entries:  r.entries,
        })),
    };
}

/**
 * Find all tag paths where multiple mods set replace:true — these are real hard
 * override conflicts where one mod wipes out another mod's contributions.
 */
export async function findTagConflicts(registry?: string): Promise<object> {
    // Find tagPaths with replace:true from more than one mod
    const replaceTags = await db().modTag.findMany({
        where: { replace: true, ...(registry ? { registry } : {}) },
        include: { mod: { select: { modId: true, displayName: true, version: true } } },
        orderBy: [{ tagPath: "asc" }],
    });

    // Group by tagPath
    const byPath: Record<string, typeof replaceTags> = {};
    for (const row of replaceTags) {
        (byPath[row.tagPath] ??= []).push(row);
    }

    const conflicts = Object.entries(byPath)
        .filter(([, rows]) => rows.length > 1)
        .map(([path, rows]) => ({
            tagPath: `#${path}`,
            registry: rows[0].registry,
            conflictingMods: rows.map((r) => ({
                mod:     r.mod.modId,
                display: r.mod.displayName,
                version: r.mod.version,
                entries: r.entries,
            })),
        }));

    // Also find tags where at least one mod uses replace:true and others don't
    // (softer conflict — one mod silently drops others' entries)
    const allTagPaths = [...new Set(replaceTags.map((r) => r.tagPath))];
    const softConflicts: Array<{ tagPath: string; registry: string; replacer: string; silencedMods: string[] }> = [];

    for (const tagPath of allTagPaths) {
        const allContribs = await db().modTag.findMany({
            where: { tagPath, ...(registry ? { registry } : {}) },
            include: { mod: { select: { modId: true } } },
        });
        const replacers = allContribs.filter((r) => r.replace).map((r) => r.mod.modId);
        const silenced  = allContribs.filter((r) => !r.replace).map((r) => r.mod.modId);
        if (replacers.length > 0 && silenced.length > 0) {
            softConflicts.push({
                tagPath:      `#${tagPath}`,
                registry:     allContribs[0].registry,
                replacer:     replacers.join(", "),
                silencedMods: silenced,
            });
        }
    }

    return {
        hardConflicts: { count: conflicts.length, conflicts },
        softConflicts: { count: softConflicts.length, conflicts: softConflicts },
    };
}

/**
 * Recursively expand a tag into its full flat member list by following nested
 * tag references (entries that start with "#") through the indexed DB.
 * Returns every concrete (non-tag) entry reachable from the root tag, plus
 * a list of all intermediate tags visited.
 *
 * tagPath: e.g. "c:ores/iron", "#forge:storage_blocks"
 * registry: optional filter (item | block | entity_type | …)
 * maxDepth: guard against circular refs (default 12)
 */
export async function expandTag(
    tagPath: string,
    registry?: string,
    maxDepth = 12,
): Promise<object> {
    const root = tagPath.startsWith("#") ? tagPath.slice(1) : tagPath;

    const visited   = new Set<string>();
    const concrete  = new Set<string>();
    const tagChain: Array<{ tag: string; contributors: string[] }> = [];
    let dbLookups   = 0;

    const expand = async (path: string, depth: number): Promise<void> => {
        if (depth > maxDepth || visited.has(path)) return;
        visited.add(path);

        const rows = await db().modTag.findMany({
            where: { tagPath: path, ...(registry ? { registry } : {}) },
            include: { mod: { select: { modId: true } } },
        });
        dbLookups++;

        if (rows.length === 0) {
            // Tag itself is not in DB — record it as unresolved concrete reference
            concrete.add(`#${path} (unresolved)`);
            return;
        }

        const contributors = [...new Set(rows.map(r => r.mod.modId))];
        tagChain.push({ tag: `#${path}`, contributors });

        // Merge all entries from all contributing mods (union)
        const allEntries = new Set<string>(rows.flatMap(r => r.entries as string[]));
        const nested: string[] = [];
        for (const entry of allEntries) {
            if (entry.startsWith("#")) nested.push(entry.slice(1));
            else concrete.add(entry);
        }
        await Promise.all(nested.map(n => expand(n, depth + 1)));
    };

    await expand(root, 0);

    return {
        rootTag:       `#${root}`,
        registry:      registry ?? "any",
        totalConcrete: concrete.size,
        totalTagsVisited: visited.size,
        dbLookups,
        note: maxDepth > 0 && visited.size >= maxDepth
            ? `Hit maxDepth=${maxDepth}; some nested tags may not be fully expanded.`
            : undefined,
        tagChain,
        members: [...concrete].sort(),
    };
}

/**
 * Search tags by path substring across all indexed mods.
 */
export async function searchModTags(query: string, registry?: string, limit = 50): Promise<object> {
    const rows = await db().modTag.findMany({
        where: {
            tagPath: { contains: query, mode: "insensitive" },
            ...(registry ? { registry } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true, version: true } } },
        orderBy: [{ tagPath: "asc" }, { mod: { modId: "asc" } }],
        take: limit,
    });

    // Group by tagPath
    const byPath: Record<string, { registry: string; contributors: Array<{ mod: string; replace: boolean; entries: string[] }> }> = {};
    for (const row of rows) {
        const key = `#${row.tagPath}`;
        if (!byPath[key]) byPath[key] = { registry: row.registry, contributors: [] };
        byPath[key].contributors.push({ mod: row.mod.modId, replace: row.replace, entries: row.entries });
    }

    return {
        query,
        registry,
        uniqueTags: Object.keys(byPath).length,
        tags: byPath,
    };
}
