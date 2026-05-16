/**
 * Pre-flight compatibility checker for a candidate mod JAR.
 *
 * Checks the candidate against all currently-ingested mods for:
 *   - Mixin target conflicts
 *   - Access Transformer / Access Widener overlaps
 *   - Asset path conflicts
 *   - Missing declared dependencies
 *   - Sidedness (informational)
 *
 * The candidate JAR does NOT need to be ingested into the DB first.
 */

import { parseJar } from "../processor.js";
import { listEntries, extractEntry } from "../jar.js";
import { validatePath } from "../security.js";
import { db } from "../db.js";
import { listModsSlim, findModsWithMixinTargetsMatching } from "../repositories/mod.js";

export type IssueSeverity = "error" | "warn" | "info";
export type IssueType =
    | "mixin_conflict" | "at_conflict" | "aw_conflict"
    | "asset_conflict" | "missing_dep"  | "sidedness";

export interface CompatIssue {
    severity: IssueSeverity;
    type: IssueType;
    detail: string;
    relatedMod?: string;
    path?: string;
}

// Loader-level pseudo-deps that are never in the mod DB
const SKIP_DEP_IDS = new Set([
    "minecraft", "neoforge", "forge", "fabric-api",
    "fabricloader", "quilt_loader", "java",
]);

const DISPLAY_TEST_MAP: Record<string, string> = {
    MATCH_VERSION:          "common",
    IGNORE_ALL_VERSION:     "client_only",
    IGNORE_SERVER_VERSION:  "client_optional",
    NONE:                   "server_only",
};

export async function checkModCompat(
    jarPath: string,
    mcVersion?: string,
    loader?: string,
): Promise<object> {
    // Path traversal guard
    validatePath(jarPath, "/");

    const manifest = await parseJar(jarPath);
    const issues: CompatIssue[] = [];

    // ── Check 1: Mixin conflicts ──────────────────────────────────────────────
    if (manifest.mixinTargets.length > 0) {
        const conflicts = await findModsWithMixinTargetsMatching(
            manifest.mixinTargets, loader, mcVersion,
        );
        for (const c of conflicts) {
            for (const target of c.matchedTargets) {
                issues.push({
                    severity: "error",
                    type: "mixin_conflict",
                    detail: `Mixin target "${target}" is already targeted by ${c.displayName} (${c.modId})`,
                    relatedMod: c.modId,
                    path: target,
                });
            }
        }
    }

    // ── Check 2: AT / AW conflicts ────────────────────────────────────────────
    const candidateAt = new Set(manifest.atEntries);
    const candidateAw = new Set(manifest.awEntries);

    if (candidateAt.size > 0 || candidateAw.size > 0) {
        const atRows = await db().$queryRawUnsafe<
            Array<{ mod_id: string; display_name: string; at_entries: unknown; aw_entries: unknown }>
        >(`SELECT mod_id, display_name, at_entries, aw_entries FROM mods WHERE has_at = true OR has_aw = true`);

        for (const row of atRows) {
            const dbAt = new Set<string>(Array.isArray(row.at_entries) ? (row.at_entries as string[]) : []);
            const dbAw = new Set<string>(Array.isArray(row.aw_entries) ? (row.aw_entries as string[]) : []);
            for (const e of candidateAt) {
                if (dbAt.has(e)) {
                    issues.push({
                        severity: "error",
                        type: "at_conflict",
                        detail: `AT entry "${e}" overlaps with ${row.display_name} (${row.mod_id})`,
                        relatedMod: row.mod_id,
                        path: e,
                    });
                }
            }
            for (const e of candidateAw) {
                if (dbAw.has(e)) {
                    issues.push({
                        severity: "error",
                        type: "aw_conflict",
                        detail: `AW entry "${e}" overlaps with ${row.display_name} (${row.mod_id})`,
                        relatedMod: row.mod_id,
                        path: e,
                    });
                }
            }
        }
    }

    // ── Check 3: Asset conflicts ──────────────────────────────────────────────
    const candidateAssetEntries = listEntries(jarPath, "assets/").filter((n) => !n.endsWith("/"));

    if (candidateAssetEntries.length > 0) {
        const candidateAssets = new Set(candidateAssetEntries);
        const pool = await listModsSlim({ mcVersion, loader });
        for (const mod of pool) {
            try {
                const modEntries = listEntries(mod.jarPath, "assets/");
                for (const entry of modEntries) {
                    if (entry.endsWith("/")) continue;
                    if (candidateAssets.has(entry)) {
                        issues.push({
                            severity: "warn",
                            type: "asset_conflict",
                            detail: `Asset "${entry}" is also shipped by ${mod.displayName} (${mod.modId})`,
                            relatedMod: mod.modId,
                            path: entry,
                        });
                    }
                }
            } catch { /* skip unreadable JARs */ }
        }
    }

    // ── Check 4: Missing declared dependencies ────────────────────────────────
    if (manifest.dependencies.length > 0) {
        // Use the same pool if already fetched, else fetch
        const allMods = await listModsSlim({ mcVersion, loader });
        const ingestedIds = new Set(allMods.map((m) => m.modId));
        for (const dep of manifest.dependencies) {
            if (SKIP_DEP_IDS.has(dep.id)) continue;
            if (!ingestedIds.has(dep.id)) {
                issues.push({
                    severity: "warn",
                    type: "missing_dep",
                    detail: `Declared dependency "${dep.id}" (${dep.version}) is not in the mod DB`,
                });
            }
        }
    }

    // ── Check 5: Sidedness (manifest-level) ───────────────────────────────────
    let sidedness = "unknown";
    let sidednessSource = "unknown";
    let sidednessEvidence = "";

    for (const mf of ["fabric.mod.json", "quilt.mod.json"]) {
        const raw = extractEntry(jarPath, mf);
        if (!raw) continue;
        try {
            const json = JSON.parse(raw.toString("utf8")) as { environment?: string };
            if      (json.environment === "client") { sidedness = "client_only"; sidednessSource = mf; sidednessEvidence = `"environment":"client"`; }
            else if (json.environment === "server") { sidedness = "server_only"; sidednessSource = mf; sidednessEvidence = `"environment":"server"`; }
            else if (json.environment === "*")      { sidedness = "common";      sidednessSource = mf; sidednessEvidence = `"environment":"*"`; }
        } catch { /* malformed */ }
        if (sidedness !== "unknown") break;
    }

    if (sidedness === "unknown") {
        for (const tf of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
            const raw = extractEntry(jarPath, tf);
            if (!raw) continue;
            const text = raw.toString("utf8");
            const m = text.match(/displayTest\s*=\s*["']?([A-Z_]+)["']?/i);
            if (m) {
                sidedness = DISPLAY_TEST_MAP[m[1]] ?? "common";
                sidednessSource = tf;
                sidednessEvidence = `displayTest = "${m[1]}"`;
            } else if (text.includes("[[mods]]")) {
                sidedness = "common";
                sidednessSource = tf;
                sidednessEvidence = "no displayTest → defaults to MATCH_VERSION (common)";
            }
            if (sidedness !== "unknown") break;
        }
    }

    if (sidedness !== "unknown" && sidedness !== "common") {
        issues.push({
            severity: "info",
            type: "sidedness",
            detail: `Mod is ${sidedness} (${sidednessEvidence} in ${sidednessSource})`,
        });
    }

    // ── Build summary ─────────────────────────────────────────────────────────
    const errors   = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warn").length;
    const infos    = issues.filter((i) => i.severity === "info").length;

    return {
        candidate: {
            modId:     manifest.modId,
            version:   manifest.version,
            loader:    manifest.loader,
            mcVersion: manifest.mcVersion,
        },
        sidedness: {
            sidedness,
            source:   sidednessSource,
            evidence: sidednessEvidence,
        },
        issues,
        summary: { errors, warnings, infos, safe: errors === 0 },
    };
}
