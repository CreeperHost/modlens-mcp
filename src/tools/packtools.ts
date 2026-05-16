/**
 * Modpack-specific analysis tools.
 *
 * Tools for modpack developers that go beyond single-mod analysis:
 *   - Asset conflict detection across all mod JARs
 *   - Vanilla data/asset override tracking
 *   - Mod sidedness classification (client-only / server-only / common / client-optional)
 *   - Mod complexity scoring for performance/compat triage
 *   - Pack-level changelog between two sets of mods
 */

import AdmZip from "adm-zip";
import { resolveModRef, listModsSlim, listMods, findModsByIds } from "../repositories/mod.js";
import { listEntries } from "../jar.js";
import { indexJar } from "../java-tools.js";

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
