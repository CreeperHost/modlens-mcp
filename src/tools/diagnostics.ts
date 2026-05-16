/**
 * Diagnostics tools for modpack developers.
 *
 * - analyzeCrashLog: rank suspect mods from a NeoForge/Fabric/Forge crash log
 *   by cross-referencing stack frames with the ModClass index.
 * - findMissingDeps: find declared dependencies not satisfied by ingested mods.
 */

import { findModClassesByClassNames, listAllMods } from "../repositories/mod.js";

// Loader-level pseudo-deps that are never in the mod DB
const SKIP_DEP_IDS = new Set([
    "minecraft", "neoforge", "forge", "fabric-api",
    "fabricloader", "quilt_loader", "java",
]);

const MAX_SUSPECTS = 10;

export async function analyzeCrashLog(logText: string): Promise<object> {
    const FRAME_RE = /\tat ([\w.$]+)\.([\w$<>[\]]+)\(/g;
    const rawFrames: string[] = [];
    for (const m of logText.matchAll(FRAME_RE)) {
        rawFrames.push(m[1].replace(/\./g, "/"));
    }

    if (rawFrames.length === 0) {
        return {
            suspects: [],
            modsInLogSection: [],
            totalFrames: 0,
            recognizedFrames: 0,
            unrecognizedFrames: 0,
        };
    }

    const uniqueClasses = [...new Set(rawFrames)];
    const rows = await findModClassesByClassNames(uniqueClasses);

    // className → mod info
    const classToMod = new Map<string, { modId: string; dbId: number; display: string }>();
    for (const row of rows) {
        classToMod.set(row.className, { modId: row.mod.modId, dbId: row.modId, display: row.mod.displayName });
    }

    // Accumulate per-mod frame lists (deduped class names) and frame counts
    const modInfo = new Map<number, { modId: string; display: string; dbId: number; frames: string[] }>();
    let recognized = 0;

    for (const cls of rawFrames) {
        const mod = classToMod.get(cls);
        if (!mod) continue;
        recognized++;
        const entry = modInfo.get(mod.dbId) ?? { modId: mod.modId, display: mod.display, dbId: mod.dbId, frames: [] };
        if (!entry.frames.includes(cls)) entry.frames.push(cls);
        modInfo.set(mod.dbId, entry);
    }

    // Build suspect list sorted by raw frame count (counts duplicates)
    const suspects = [...modInfo.values()]
        .map((s) => ({
            modId: s.modId,
            display: s.display,
            dbId: s.dbId,
            frameCount: rawFrames.filter((c) => classToMod.get(c)?.dbId === s.dbId).length,
            frames: s.frames.slice(0, 5),
        }))
        .sort((a, b) => b.frameCount - a.frameCount)
        .slice(0, MAX_SUSPECTS);

    // Parse "-- Mod List --" section (NeoForge crash format)
    const modsInLogSection: string[] = [];
    const modListMatch = logText.match(/-- Mod List --\n([\s\S]*?)(?:\n--|$)/);
    if (modListMatch) {
        for (const line of modListMatch[1].split("\n")) {
            const m = line.match(/^\s*(\S+)\|/);
            if (m) modsInLogSection.push(m[1].trim());
        }
    }

    const unrecognized = rawFrames.length - recognized;
    const coverageWarning =
        rawFrames.length >= 5 && unrecognized / rawFrames.length > 0.5
            ? `${unrecognized}/${rawFrames.length} stack frames could not be matched to ingested mods. Run reindex_classes to improve coverage.`
            : undefined;

    return {
        suspects,
        modsInLogSection,
        totalFrames: rawFrames.length,
        recognizedFrames: recognized,
        unrecognizedFrames: unrecognized,
        ...(coverageWarning ? { coverageWarning } : {}),
    };
}

export async function findMissingDeps(mcVersion?: string, loader?: string): Promise<object> {
    const allMods = await listAllMods();

    // Full ingested modId set (not filtered — deps may cross mcVersion boundaries)
    const ingestedIds = new Set(allMods.map((m) => m.modId));

    // Filter comparison pool to mcVersion/loader if requested
    const pool = allMods.filter((m) => {
        if (mcVersion && !m.mcVersion.includes(mcVersion)) return false;
        if (loader && m.loader !== loader) return false;
        return true;
    });

    type DepEntry = { id: string; version: string; required: boolean };

    const missing: Array<{
        requiredBy: string;
        requiredByDisplay: string;
        depModId: string;
        versionRange: string;
        mandatory: boolean;
    }> = [];
    let satisfied = 0;

    for (const mod of pool) {
        let deps: DepEntry[] = [];
        try {
            const raw = mod.dependencies;
            deps = Array.isArray(raw) ? (raw as DepEntry[]) : [];
        } catch {
            deps = [];
        }

        for (const dep of deps) {
            if (!dep.id || SKIP_DEP_IDS.has(dep.id)) continue;
            if (ingestedIds.has(dep.id)) {
                satisfied++;
            } else {
                missing.push({
                    requiredBy: mod.modId,
                    requiredByDisplay: mod.displayName,
                    depModId: dep.id,
                    versionRange: dep.version ?? "*",
                    mandatory: dep.required ?? true,
                });
            }
        }
    }

    return {
        mcVersion: mcVersion ?? "all",
        loader: loader ?? "all",
        modsChecked: pool.length,
        missing,
        satisfied,
        unsatisfied: missing.length,
    };
}
