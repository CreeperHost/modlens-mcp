/**
 * Modpack-specific analysis tools.
 *
 * Tools for modpack developers that go beyond single-mod analysis:
 *   - Asset conflict detection across all mod JARs
 *   - Vanilla data/asset override tracking
 *   - Mod sidedness classification (client-only / server-only / common / client-optional)
 *   - Mod complexity scoring for performance/compat triage
 *   - Pack-level changelog between two sets of mods
 *   - Pack knowledge graph — composite graph of all mods, deps, tags, mixins, and optionally KubeJS scripts
 */

import AdmZip from "adm-zip";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, normalize, isAbsolute } from "path";
import { resolveModRef, listModsSlim, listMods, findModsByIds } from "../repositories/mod.js";
import { listEntries, extractEntry } from "../jar.js";
import { indexJar } from "../java-tools.js";
import { assertJarPath } from "../security.js";
import { getDb } from "../db.js";
import { indexKubeJsScripts } from "./kubejs.js";

// ── Asset conflict detection ───────────────────────────────────────────────────

/**
 * Scan all mod JARs in the DB for duplicate asset paths.
 * When two mods ship the same assets/ path, the last-loaded mod silently wins.
 *
 * assetType: filter to a specific sub-folder (textures | models | sounds | blockstates | shaders | all)
 * mcVersion / loader: optional DB filters
 * limit: max conflicts to return (default 300)
 */
export async function findAssetConflicts(
    assetType?: string,
    mcVersion?: string,
    loader?: string,
    limit = 300,
): Promise<object> {
    const mods = await listModsSlim({ mcVersion, loader });

    const typeFilter = assetType && assetType !== "all" ? assetType : null;
    const pathMap = new Map<string, Array<{ mod: string; display: string }>>();

    for (const mod of mods) {
        try {
            assertJarPath(mod.jarPath);
            const entries = listEntries(mod.jarPath, "assets/");
            for (const entry of entries) {
                if (entry.endsWith("/")) continue;
                if (typeFilter && !entry.includes(`/${typeFilter}/`)) continue;
                const list = pathMap.get(entry) ?? [];
                list.push({ mod: mod.modId, display: mod.displayName });
                pathMap.set(entry, list);
            }
        } catch { /* skip unreadable JARs */ }
    }

    const conflicts = [...pathMap.entries()]
        .filter(([, owners]) => owners.length >= 2)
        .map(([path, owners]) => ({ path, modCount: owners.length, mods: owners }))
        .sort((a, b) => b.modCount - a.modCount)
        .slice(0, limit);

    // Group by asset folder type
    const byType: Record<string, number> = {};
    for (const c of conflicts) {
        const m = c.path.match(/^assets\/[^/]+\/([^/]+)\//);
        const t = m?.[1] ?? "other";
        byType[t] = (byType[t] ?? 0) + 1;
    }

    return {
        modsScanned:    mods.length,
        totalConflicts: conflicts.length,
        capped:         conflicts.length >= limit,
        note:           "When two mods ship the same assets/ path, the last-loaded mod wins and silently replaces the other's visuals/sounds.",
        byType,
        conflicts,
    };
}

// ── Vanilla override tracking ──────────────────────────────────────────────────

/**
 * Find all mods that override vanilla (minecraft namespace) data or assets.
 * data/minecraft/ overrides affect recipes, loot tables, advancements, etc.
 * assets/minecraft/ overrides change vanilla textures, sounds, models.
 *
 * overrideType: "data" | "assets" | "all" (default all)
 * dataSubtype: optional subfolder filter, e.g. "recipes", "loot_tables", "advancements"
 */
export async function findVanillaOverrides(
    overrideType?: string,
    dataSubtype?: string,
    mcVersion?: string,
    loader?: string,
): Promise<object> {
    const mods = await listModsSlim({ mcVersion, loader });

    const checkData   = !overrideType || overrideType === "all" || overrideType === "data";
    const checkAssets = !overrideType || overrideType === "all" || overrideType === "assets";

    const results: Array<{
        mod: string; display: string; version: string;
        dataOverrides: string[]; assetOverrides: string[];
    }> = [];

    for (const mod of mods) {
        try {
            const dataOverrides: string[] = [];
            const assetOverrides: string[] = [];

            if (checkData) {
                const entries = listEntries(mod.jarPath, "data/minecraft/");
                const filtered = dataSubtype
                    ? entries.filter(e => e.includes(`/minecraft/${dataSubtype}/`))
                    : entries;
                dataOverrides.push(...filtered.filter(e => !e.endsWith("/")));
            }
            if (checkAssets) {
                assetOverrides.push(
                    ...listEntries(mod.jarPath, "assets/minecraft/").filter(e => !e.endsWith("/"))
                );
            }

            if (dataOverrides.length > 0 || assetOverrides.length > 0) {
                results.push({ mod: mod.modId, display: mod.displayName, version: mod.version, dataOverrides, assetOverrides });
            }
        } catch { /* skip */ }
    }

    const totalData   = results.reduce((s, r) => s + r.dataOverrides.length, 0);
    const totalAssets = results.reduce((s, r) => s + r.assetOverrides.length, 0);

    return {
        modsScanned:         mods.length,
        modsWithOverrides:   results.length,
        totalDataOverrides:  totalData,
        totalAssetOverrides: totalAssets,
        note: "data/minecraft/ overrides can silently change vanilla recipes, loot tables, and advancements. assets/minecraft/ overrides replace vanilla textures and sounds.",
        results,
    };
}

// ── Mod sidedness analysis ─────────────────────────────────────────────────────

const DISPLAY_TEST_MAP: Record<string, string> = {
    "IGNORE_SERVER_VERSION": "client_optional", // client recommends it; dedicated server doesn't require it
    "IGNORE_ALL_VERSION":    "client_only",     // not needed on dedicated server at all
    "MATCH_VERSION":         "common",          // required on both sides (default)
};

const CLIENT_MARKERS = [
    "net/minecraft/client/",
    "net/neoforged/neoforge/client/",
    "net/minecraftforge/client/",
    "net/fabricmc/fabric/api/client/",
    "FMLClientSetupEvent",
];

const SERVER_MARKERS = [
    "FMLDedicatedServerSetupEvent",
    "net/neoforged/neoforge/event/server/",
    "ServerLifecycleEvents",
];

export type ModSidedness = "client_only" | "server_only" | "client_optional" | "common" | "unknown";

/**
 * Determine the sidedness of a single mod:
 *   client_only:     not needed on dedicated server
 *   server_only:     not needed on client
 *   client_optional: works without it on server (cosmetic/HUD/minimap mods)
 *   common:          required on both sides
 *
 * Detection order:
 *   1. fabric.mod.json "environment" field (authoritative for Fabric/Quilt)
 *   2. neoforge.mods.toml / mods.toml "displayTest" (authoritative for NeoForge/Forge)
 *   3. Bytecode reference heuristic (fallback)
 */
export async function analyzeModSidedness(modIdOrDbId: string | number): Promise<object> {
    const mod = await resolveModRef(String(modIdOrDbId));
    if (!mod) return { error: `Mod not found: ${modIdOrDbId}` };

    let sidedness: ModSidedness = "unknown";
    let source   = "unknown";
    let evidence = "";

    const zip = new AdmZip(mod.jarPath);

    // 1. Fabric / Quilt: fabric.mod.json "environment"
    for (const manifestFile of ["fabric.mod.json", "quilt.mod.json"]) {
        const entry = zip.getEntry(manifestFile);
        if (!entry) continue;
        try {
            const json = JSON.parse(zip.readFile(entry)!.toString("utf8")) as { environment?: string };
            if (json.environment === "client") { sidedness = "client_only"; source = manifestFile; evidence = `"environment": "client"`; }
            else if (json.environment === "server") { sidedness = "server_only"; source = manifestFile; evidence = `"environment": "server"`; }
            else if (json.environment === "*")      { sidedness = "common";      source = manifestFile; evidence = `"environment": "*"`; }
        } catch {}
        if (sidedness !== "unknown") break;
    }

    // 2. NeoForge / Forge: mods.toml displayTest
    if (sidedness === "unknown") {
        for (const tomlPath of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
            const entry = zip.getEntry(tomlPath);
            if (!entry) continue;
            const raw = zip.readFile(entry)!.toString("utf8");
            const m = raw.match(/displayTest\s*=\s*["']?([A-Z_]+)["']?/i);
            if (m) {
                sidedness = (DISPLAY_TEST_MAP[m[1]] as ModSidedness) ?? "common";
                source    = tomlPath;
                evidence  = `displayTest = "${m[1]}"`;
            } else if (raw.includes("[[mods]]")) {
                // Present but no displayTest → defaults to MATCH_VERSION (common)
                sidedness = "common";
                source    = tomlPath;
                evidence  = "no displayTest field → defaults to MATCH_VERSION (common)";
            }
            if (sidedness !== "unknown") break;
        }
    }

    // 3. Bytecode heuristic
    if (sidedness === "unknown") {
        try {
            const index    = await indexJar(mod.jarPath);
            const refKeys  = Object.keys(index.references);
            const hasClient = CLIENT_MARKERS.some(m => refKeys.some(k => k.includes(m)));
            const hasServer = SERVER_MARKERS.some(m => refKeys.some(k => k.includes(m)));
            if      ( hasClient && !hasServer) { sidedness = "client_only"; source = "bytecode"; evidence = "references client APIs, no server-only APIs"; }
            else if (!hasClient &&  hasServer) { sidedness = "server_only"; source = "bytecode"; evidence = "references server APIs, no client-only APIs"; }
            else if ( hasClient &&  hasServer) { sidedness = "common";      source = "bytecode"; evidence = "references both client and server APIs"; }
            else                               { sidedness = "common";      source = "bytecode"; evidence = "no clear client/server markers — assumed common"; }
        } catch {}
    }

    return {
        mod:      mod.modId,
        display:  mod.displayName,
        version:  mod.version,
        loader:   mod.loader,
        sidedness,
        source,
        evidence,
    };
}

/**
 * Classify all mods in the DB by sidedness.
 * Groups results into: client_only / server_only / client_optional / common / unknown.
 */
export async function analyzePackSidedness(
    mcVersion?: string,
    loader?: string,
): Promise<object> {
    const mods = await listModsSlim({ mcVersion, loader });

    // Analyse concurrently in batches of 10 to avoid overwhelming the JAR reader
    const BATCH = 10;
    const all: object[] = [];
    for (let i = 0; i < mods.length; i += BATCH) {
        const batch = mods.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(m => analyzeModSidedness(m.id)));
        all.push(...results);
    }

    type Row = { mod: string; display: string; version: string; sidedness: ModSidedness; source: string; evidence: string; error?: string };
    const grouped: Record<ModSidedness, Array<{ mod: string; display: string; version: string; source: string; evidence: string }>> = {
        client_only: [], server_only: [], client_optional: [], common: [], unknown: [],
    };
    for (const r of all as Row[]) {
        if (r.error) continue;
        grouped[r.sidedness].push({ mod: r.mod, display: r.display, version: r.version, source: r.source, evidence: r.evidence });
    }

    return {
        mcVersion: mcVersion ?? "(all)",
        loader:    loader    ?? "(all)",
        summary: {
            client_only:     grouped.client_only.length,
            server_only:     grouped.server_only.length,
            client_optional: grouped.client_optional.length,
            common:          grouped.common.length,
            unknown:         grouped.unknown.length,
            total:           mods.length,
        },
        note: "client_only mods can be removed from dedicated servers. client_optional mods are not required on the server side. server_only mods can be removed from client-only installations.",
        grouped,
    };
}

// ── Mod complexity scoring ────────────────────────────────────────────────────

/**
 * Compute a complexity / heaviness score per mod.
 * Score = classCount + atCount×10 + awCount×10 + mixinCount×20
 *
 * Useful for identifying which mods are the biggest sources of class
 * transformer / mixin overhead — helpful when diagnosing crashes or lag.
 */
export async function computeModComplexity(
    mcVersion?: string,
    loader?: string,
): Promise<object> {
    const mods = await listMods({ mcVersion, loader, limit: 9999 });

    const results: Array<{
        mod: string; display: string; version: string; loader: string;
        classCount: number; mixinCount: number; atCount: number; awCount: number; score: number;
    }> = [];

    for (const mod of mods) {
        let classCount = 0;
        try {
            classCount = listEntries(mod.jarPath).filter(e => e.endsWith(".class")).length;
        } catch {}
        const atCount    = (mod.atEntries    as string[]).length;
        const awCount    = (mod.awEntries    as string[]).length;
        const mixinCount = (mod.mixinTargets as string[]).length;

        // Weighted: raw class count, mixin targets are heavier (each is a transformation hook)
        const score = classCount + atCount * 10 + awCount * 10 + mixinCount * 20;

        results.push({ mod: mod.modId, display: mod.displayName, version: mod.version, loader: mod.loader, classCount, mixinCount, atCount, awCount, score });
    }

    results.sort((a, b) => b.score - a.score);

    return {
        mcVersion: mcVersion ?? "(all)",
        loader:    loader    ?? "(all)",
        note:      "Score = classCount + (atEntries + awEntries)×10 + mixinTargets×20. Higher score = heavier class transformer/mixin footprint.",
        mods:      results,
    };
}

// ── Pack changelog ─────────────────────────────────────────────────────────────

/**
 * Compare two sets of mod DB ids (old pack vs new pack).
 * Returns: added mods, removed mods, updated mods (same modId, different version).
 *
 * oldIds: DB ids representing the old pack state
 * newIds: DB ids representing the new pack state
 */
export async function computePackChangelog(
    oldIds: number[],
    newIds: number[],
): Promise<object> {
    const [oldMods, newMods] = await Promise.all([
        findModsByIds(oldIds),
        findModsByIds(newIds),
    ]);

    const oldMap = new Map(oldMods.map(m => [m.modId, m]));
    const newMap = new Map(newMods.map(m => [m.modId, m]));

    const added   = newMods.filter(m => !oldMap.has(m.modId)).map(m => ({ mod: m.modId, display: m.displayName, version: m.version }));
    const removed = oldMods.filter(m => !newMap.has(m.modId)).map(m => ({ mod: m.modId, display: m.displayName, version: m.version }));
    const updated: Array<{ mod: string; display: string; oldVersion: string; newVersion: string }> = [];

    for (const [modId, oldMod] of oldMap) {
        const newMod = newMap.get(modId);
        if (newMod && newMod.version !== oldMod.version) {
            updated.push({ mod: modId, display: newMod.displayName, oldVersion: oldMod.version, newVersion: newMod.version });
        }
    }

    return {
        summary: { added: added.length, removed: removed.length, updated: updated.length },
        oldPackSize: oldMods.length,
        newPackSize: newMods.length,
        added,
        removed,
        updated,
    };
}

// ── Data conflict detection ────────────────────────────────────────────────────

/**
 * Scan all mod JARs in the DB for duplicate data resource paths.
 * When two mods ship the same data/ path, the last-loaded mod silently wins.
 *
 * dataType: filter to specific data sub-folder
 *   (recipe | loot_tables | advancements | tags | structures | all)
 * mcVersion / loader: optional DB filters
 * limit: max conflicts to return (default 300)
 */
export async function findDataConflicts(
    dataType?: string,
    mcVersion?: string,
    loader?: string,
    limit = 300,
): Promise<object> {
    const mods = await listModsSlim({ mcVersion, loader });

    const typeFilter = dataType && dataType !== "all" ? dataType : null;
    const pathMap = new Map<string, Array<{ mod: string; display: string }>>();

    for (const mod of mods) {
        try {
            const entries = listEntries(mod.jarPath, "data/");
            for (const entry of entries) {
                if (entry.endsWith("/")) continue;
                if (typeFilter && !entry.includes(`/${typeFilter}/`)) continue;
                const list = pathMap.get(entry) ?? [];
                list.push({ mod: mod.modId, display: mod.displayName });
                pathMap.set(entry, list);
            }
        } catch { /* skip unreadable JARs */ }
    }

    const conflicts: Array<{
        path: string;
        isVanillaOverride: boolean;
        modCount: number;
        mods: Array<{ mod: string; display: string }>;
    }> = [];

    for (const [path, owners] of pathMap) {
        if (owners.length < 2) continue;
        conflicts.push({
            path,
            isVanillaOverride: path.startsWith("data/minecraft/"),
            modCount: owners.length,
            mods: owners,
        });
    }

    conflicts.sort((a, b) => b.modCount - a.modCount);

    const capped = conflicts.length > limit;
    const limited = conflicts.slice(0, limit);

    // byType breakdown: data/<namespace>/<type>/... → parts[2]
    const byType: Record<string, number> = {};
    for (const c of limited) {
        const parts = c.path.split("/");
        const t = parts[2] ?? "unknown";
        byType[t] = (byType[t] ?? 0) + 1;
    }

    const vanillaOverrideConflicts = limited.filter((c) => c.isVanillaOverride).length;

    return {
        modsScanned: mods.length,
        totalConflicts: limited.length,
        capped,
        byType,
        vanillaOverrideConflicts,
        note: capped ? `Results capped at ${limit}. Use dataType or loader/mcVersion to narrow.` : "",
        conflicts: limited,
    };
}

// ── Pack knowledge graph ───────────────────────────────────────────────────────

interface GraphNode {
    id: string;
    type: "mod" | "mc_class" | "tag" | "script" | "script_category";
    label: string;
    meta?: Record<string, unknown>;
}

interface GraphEdge {
    source: string;
    target: string;
    type: "depends_on" | "mixes_into" | "contributes_tag" | "tag_conflict" | "script_modifies" | "has_category";
    meta?: Record<string, unknown>;
}

/**
 * Build a composite knowledge graph of the entire modpack.
 *
 * Nodes: mods, mixin target classes, tags, KubeJS scripts, script categories
 * Edges: depends_on, mixes_into, contributes_tag, tag_conflict, script_modifies, has_category
 *
 * @param mcVersion  optional MC version filter
 * @param loader     optional loader filter
 * @param scriptsDir optional path to kubejs/ directory to include script analysis
 */
export async function buildPackGraph(
    mcVersion?: string,
    loader?: string,
    scriptsDir?: string,
): Promise<object> {
    const db = await getDb();

    // 1. Fetch all mods with deps and mixin data
    const mods = await db.mod.findMany({
        where: {
            ...(mcVersion ? { mcVersion: { contains: mcVersion } } : {}),
            ...(loader ? { loader } : {}),
        },
        select: {
            id: true, modId: true, displayName: true, version: true,
            loader: true, mcVersion: true, hasMixins: true,
            dependencies: true, mixinTargets: true,
        },
    });

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();

    const addNode = (n: GraphNode) => {
        if (nodeIds.has(n.id)) return;
        nodeIds.add(n.id);
        nodes.push(n);
    };

    // Loader pseudo-deps to skip
    const PSEUDO_DEPS = new Set(["minecraft", "neoforge", "forge", "fabricloader", "fabric-api", "java", "quilt_loader"]);

    // 2. Mod nodes + dependency edges
    for (const mod of mods) {
        addNode({
            id: `mod:${mod.modId}`,
            type: "mod",
            label: mod.displayName,
            meta: { version: mod.version, loader: mod.loader, mcVersion: mod.mcVersion },
        });

        const deps = (mod.dependencies ?? []) as Array<{ id: string; version?: string; required?: boolean }>;
        for (const dep of deps) {
            if (!dep.id || PSEUDO_DEPS.has(dep.id)) continue;
            const targetId = `mod:${dep.id}`;
            addNode({ id: targetId, type: "mod", label: dep.id });
            edges.push({
                source: `mod:${mod.modId}`,
                target: targetId,
                type: "depends_on",
                meta: { required: dep.required ?? true, versionRange: dep.version },
            });
        }

        // 3. Mixin target edges
        const targets = (mod.mixinTargets ?? []) as string[];
        for (const cls of targets) {
            const classId = `class:${cls}`;
            addNode({ id: classId, type: "mc_class", label: cls.split("/").pop() ?? cls, meta: { fqn: cls } });
            edges.push({ source: `mod:${mod.modId}`, target: classId, type: "mixes_into" });
        }
    }

    // 4. Tag contribution edges
    const tags = await db.modTag.findMany({
        where: {
            mod: {
                ...(mcVersion ? { mcVersion: { contains: mcVersion } } : {}),
                ...(loader ? { loader } : {}),
            },
        },
        select: { modId: true, tagPath: true, registry: true, replace: true, mod: { select: { modId: true } } },
    });

    const tagContributors = new Map<string, Array<{ modId: string; replace: boolean }>>();
    for (const t of tags) {
        const tagId = `tag:${t.registry}/${t.tagPath}`;
        addNode({ id: tagId, type: "tag", label: `#${t.tagPath}`, meta: { registry: t.registry } });
        edges.push({
            source: `mod:${t.mod.modId}`,
            target: tagId,
            type: "contributes_tag",
            meta: { replace: t.replace },
        });
        const list = tagContributors.get(tagId) ?? [];
        list.push({ modId: t.mod.modId, replace: t.replace });
        tagContributors.set(tagId, list);
    }

    // 5. Tag conflict edges (multiple mods with replace:true on same tag)
    for (const [tagId, contributors] of tagContributors) {
        const replacers = contributors.filter(c => c.replace);
        if (replacers.length >= 2) {
            for (let i = 0; i < replacers.length; i++) {
                for (let j = i + 1; j < replacers.length; j++) {
                    edges.push({
                        source: `mod:${replacers[i].modId}`,
                        target: `mod:${replacers[j].modId}`,
                        type: "tag_conflict",
                        meta: { tag: tagId },
                    });
                }
            }
        }
    }

    // 6. KubeJS scripts (optional)
    let kubeJsStats: { fileCount: number; categories: Record<string, number> } | undefined;
    if (scriptsDir) {
        try {
            const kjResult = await indexKubeJsScripts(scriptsDir) as {
                fileCount: number;
                categorySummary: Record<string, number>;
                scripts: Array<{ path: string; lineCount: number; categories: string[] }>;
            };
            kubeJsStats = { fileCount: kjResult.fileCount, categories: kjResult.categorySummary };

            for (const cat of Object.keys(kjResult.categorySummary)) {
                addNode({ id: `kjs_cat:${cat}`, type: "script_category", label: cat });
            }

            for (const script of kjResult.scripts) {
                const scriptId = `script:${script.path}`;
                addNode({
                    id: scriptId,
                    type: "script",
                    label: script.path.split("/").pop() ?? script.path,
                    meta: { path: script.path, lineCount: script.lineCount },
                });
                for (const cat of script.categories) {
                    edges.push({ source: scriptId, target: `kjs_cat:${cat}`, type: "has_category" });
                    if (cat.startsWith("recipe_") || cat === "tag_modify" || cat === "loot_modify") {
                        edges.push({ source: scriptId, target: `kjs_cat:${cat}`, type: "script_modifies" });
                    }
                }
            }
        } catch { /* scriptsDir unreadable — skip */ }
    }

    // 7. Summary stats
    const byNodeType: Record<string, number> = {};
    for (const n of nodes) byNodeType[n.type] = (byNodeType[n.type] ?? 0) + 1;
    const byEdgeType: Record<string, number> = {};
    for (const e of edges) byEdgeType[e.type] = (byEdgeType[e.type] ?? 0) + 1;

    const edgeCounts = new Map<string, number>();
    for (const e of edges) {
        edgeCounts.set(e.source, (edgeCounts.get(e.source) ?? 0) + 1);
        edgeCounts.set(e.target, (edgeCounts.get(e.target) ?? 0) + 1);
    }
    const hubs = [...edgeCounts.entries()]
        .filter(([id]) => id.startsWith("mod:"))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, count]) => ({ id, connections: count }));

    const mixinHotspots = [...edgeCounts.entries()]
        .filter(([id]) => id.startsWith("class:"))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, count]) => ({ id, modCount: count }));

    return {
        summary: {
            totalNodes: nodes.length,
            totalEdges: edges.length,
            byNodeType,
            byEdgeType,
            hubs,
            mixinHotspots,
            ...(kubeJsStats ? { kubeJs: kubeJsStats } : {}),
        },
        nodes,
        edges,
    };
}

// ── Config diff analysis ───────────────────────────────────────────────────────

/**
 * Walk a directory tree recursively and return relative paths of all files.
 */
function walkDir(dir: string, base = dir): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkDir(full, base));
        } else if (entry.isFile()) {
            files.push(relative(base, full).replace(/\\/g, "/"));
        }
    }
    return files;
}

/**
 * Compare a modpack's config directory against default configs bundled in mod JARs.
 *
 * For each ingested mod, extracts default config files from the JAR
 * (`defaultconfigs/` and `config/` prefixes) and compares against the
 * on-disk pack config directory.
 *
 * Returns:
 *   - modified:  files that exist in both the pack and a JAR default, but content differs
 *   - custom:    files on disk that don't match any mod's JAR defaults
 *   - unchanged: files identical to the JAR default
 *
 * @param configDir  absolute path to the modpack's config/ directory
 * @param mcVersion  optional MC version filter
 * @param loader     optional loader filter
 */
export async function diffPackConfigs(
    configDir: string,
    mcVersion?: string,
    loader?: string,
): Promise<object> {
    const resolved = normalize(configDir);
    if (!isAbsolute(resolved)) {
        return { error: "configDir must be an absolute path" };
    }
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        return { error: `Config directory not found or not a directory: ${configDir}` };
    }

    const mods = await listModsSlim({ mcVersion, loader });

    // Build a map of config filename → { modId, jarPath, jarEntryPath, content }
    // We strip the "config/" or "defaultconfigs/" prefix from JAR entry paths to match disk layout
    interface JarDefault { modId: string; display: string; jarEntry: string; content: Buffer }
    const defaults = new Map<string, JarDefault[]>();

    for (const mod of mods) {
        try {
            assertJarPath(mod.jarPath);
            for (const prefix of ["config/", "defaultconfigs/"]) {
                const entries = listEntries(mod.jarPath, prefix);
                for (const entry of entries) {
                    if (entry.endsWith("/")) continue;
                    // Normalize to relative config path (strip prefix for matching)
                    const relPath = entry.startsWith("defaultconfigs/")
                        ? entry.slice("defaultconfigs/".length)
                        : entry.slice("config/".length);
                    const buf = extractEntry(mod.jarPath, entry);
                    if (!buf) continue;
                    const list = defaults.get(relPath) ?? [];
                    list.push({ modId: mod.modId, display: mod.displayName, jarEntry: entry, content: buf });
                    defaults.set(relPath, list);
                }
            }
        } catch { /* skip unreadable JARs */ }
    }

    // Walk the on-disk config directory
    const diskFiles = walkDir(configDir);

    const modified: Array<{ file: string; mod: string; display: string; jarEntry: string; sizeDisk: number; sizeJar: number }> = [];
    const unchanged: Array<{ file: string; mod: string; display: string }> = [];
    const custom: string[] = [];

    for (const diskRel of diskFiles) {
        const jarDefaults = defaults.get(diskRel);
        if (!jarDefaults || jarDefaults.length === 0) {
            custom.push(diskRel);
            continue;
        }

        let diskContent: Buffer;
        try {
            diskContent = readFileSync(join(configDir, diskRel));
        } catch {
            custom.push(diskRel);
            continue;
        }

        // Compare against each mod that ships this config (typically one)
        let anyDiff = false;
        for (const def of jarDefaults) {
            if (diskContent.equals(def.content)) {
                unchanged.push({ file: diskRel, mod: def.modId, display: def.display });
            } else {
                modified.push({
                    file: diskRel,
                    mod: def.modId,
                    display: def.display,
                    jarEntry: def.jarEntry,
                    sizeDisk: diskContent.length,
                    sizeJar: def.content.length,
                });
                anyDiff = true;
            }
        }
        if (!anyDiff && !unchanged.some(u => u.file === diskRel)) {
            custom.push(diskRel);
        }
    }

    // Also report JAR defaults that have no on-disk counterpart (could indicate a missing config)
    const missing: Array<{ file: string; mod: string; display: string }> = [];
    for (const [relPath, defs] of defaults) {
        if (!diskFiles.includes(relPath)) {
            for (const def of defs) {
                missing.push({ file: relPath, mod: def.modId, display: def.display });
            }
        }
    }

    return {
        configDir,
        modsScanned: mods.length,
        totalDiskFiles: diskFiles.length,
        totalJarDefaults: defaults.size,
        summary: {
            modified: modified.length,
            unchanged: unchanged.length,
            custom: custom.length,
            missingOnDisk: missing.length,
        },
        note: "modified = pack config differs from JAR default. custom = on disk but no JAR default found. missing = JAR ships a default but no on-disk file exists.",
        modified,
        unchanged,
        custom,
        missing,
    };
}

// ── Pack health summary ────────────────────────────────────────────────────────

/**
 * One-shot modpack health overview.
 * Aggregates key metrics in a single call to give agents a fast starting point:
 *   - mod count, loader/MC version breakdown
 *   - missing dependency count
 *   - mixin hotspot count (classes targeted by 3+ mods)
 *   - asset/data conflict counts
 *   - sidedness breakdown (client_only / server_only / common)
 */
export async function packHealth(
    mcVersion?: string,
    loader?: string,
): Promise<object> {
    const db = await getDb();

    // 1. Basic stats
    const where = {
        ...(mcVersion ? { mcVersion: { contains: mcVersion } } : {}),
        ...(loader ? { loader } : {}),
    };
    const mods = await db.mod.findMany({
        where,
        select: {
            id: true, modId: true, displayName: true, version: true,
            loader: true, mcVersion: true, hasMixins: true,
            dependencies: true, mixinTargets: true,
            modrinthId: true, curseforgeId: true,
        },
    });

    const loaderBreakdown: Record<string, number> = {};
    const versionBreakdown: Record<string, number> = {};
    let withMixins = 0, linkedMR = 0, linkedCF = 0;

    for (const m of mods) {
        loaderBreakdown[m.loader] = (loaderBreakdown[m.loader] ?? 0) + 1;
        versionBreakdown[m.mcVersion] = (versionBreakdown[m.mcVersion] ?? 0) + 1;
        if (m.hasMixins) withMixins++;
        if (m.modrinthId) linkedMR++;
        if (m.curseforgeId) linkedCF++;
    }

    // 2. Missing deps (lightweight inline check)
    const SKIP = new Set(["minecraft", "neoforge", "forge", "fabric-api", "fabricloader", "quilt_loader", "java"]);
    const ingestedIds = new Set(mods.map(m => m.modId));
    let missingDeps = 0;
    const missingList: Array<{ dep: string; requiredBy: string }> = [];
    for (const mod of mods) {
        const deps = (mod.dependencies ?? []) as Array<{ id?: string; required?: boolean }>;
        for (const dep of deps) {
            if (!dep.id || SKIP.has(dep.id)) continue;
            if (!ingestedIds.has(dep.id)) {
                missingDeps++;
                if (missingList.length < 10) {
                    missingList.push({ dep: dep.id, requiredBy: mod.modId });
                }
            }
        }
    }

    // 3. Mixin hotspots (classes targeted by 3+ mods)
    const classHits = new Map<string, Set<string>>();
    for (const mod of mods) {
        const targets = (mod.mixinTargets ?? []) as string[];
        for (const cls of targets) {
            const set = classHits.get(cls) ?? new Set();
            set.add(mod.modId);
            classHits.set(cls, set);
        }
    }
    const hotspots = [...classHits.entries()]
        .filter(([, mods]) => mods.size >= 3)
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, 10)
        .map(([cls, modSet]) => ({ class: cls, modCount: modSet.size, mods: [...modSet].slice(0, 5) }));

    // 4. Tag conflicts (lightweight — count only from indexed tags)
    let tagConflicts = 0;
    try {
        const tags = await db.modTag.groupBy({
            by: ["tagPath", "registry"],
            where: { replace: true, mod: where },
            _count: { modId: true },
        });
        tagConflicts = tags.filter(t => t._count.modId >= 2).length;
    } catch { /* tag table may not exist */ }

    return {
        mcVersion: mcVersion ?? "(all)",
        loader: loader ?? "(all)",
        totalMods: mods.length,
        loaderBreakdown,
        versionBreakdown,
        modsWithMixins: withMixins,
        platformLinks: { modrinth: linkedMR, curseforge: linkedCF, unlinked: mods.length - Math.max(linkedMR, linkedCF) },
        issues: {
            missingDeps,
            missingDepsTop: missingList,
            mixinHotspots: hotspots.length,
            mixinHotspotsTop: hotspots,
            tagConflicts,
        },
        note: "Use specific pack_tools actions for detailed analysis: asset_conflicts, data_conflicts, config_diff, pack_sidedness.",
    };
}
