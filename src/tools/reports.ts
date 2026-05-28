/**
 * Markdown report generator.
 *
 * Calls the existing tool functions and renders results as formatted Markdown
 * that humans can copy/share. All reports are also optionally saved to disk.
 *
 * Reports available:
 *   - mixin_conflicts        — cross-mod mixin conflict matrix
 *   - tag_conflicts          — replace:true tag conflicts across mods
 *   - tag_contributors       — who contributes to a specific tag
 *   - dependency_graph       — full dep graph or per-mod deps
 *   - version_conflicts      — duplicate mod versions + unsatisfied deps
 *   - mod_overview           — summary of a single mod (tags, mixins, deps, source)
 *   - gradle_deps            — cross-mod gradle dependency comparison
 */
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { resolveModRef, findModTagsByMod } from "../repositories/mod.js";
import { getDb } from "../db.js";
import { getMixinConflictMatrix, getMixinHotspots, listModsWithMixins } from "./mixin-scan.js";
import { findTagConflicts, getTagContributors, getModTagList, searchModTags } from "./mod-tags.js";
import { findVersionConflicts, getDependencyGraph, listModSourceUrls } from "./catalog.js";
import { compareGradleDeps } from "./gradle.js";
import { getMixinConflicts } from "./mixin-scan.js";
import { findAtAwConflicts } from "./mixin-scan.js";
import { findTagConflicts as _ftc } from "./mod-tags.js";
import { analyzePackSidedness, computeModComplexity, computePackChangelog } from "./packtools.js";

// ── Markdown helpers ──────────────────────────────────────────────────────────

function h1(s: string) { return `# ${s}\n`; }
function h2(s: string) { return `\n## ${s}\n`; }
function h3(s: string) { return `\n### ${s}\n`; }
function bold(s: string) { return `**${s}**`; }
function code(s: string) { return `\`${s}\``; }
function tableRow(cells: string[]) { return `| ${cells.join(" | ")} |`; }
function tableHeader(cols: string[]) {
    return tableRow(cols) + "\n" + tableRow(cols.map(() => "---"));
}
function timestamp() { return `*Generated: ${new Date().toISOString()}*`; }

// ── Report renderers ──────────────────────────────────────────────────────────

async function reportMixinConflicts(opts: { loader?: string; mcVersion?: string; minConflicts?: number }): Promise<string> {
    const data = await getMixinConflictMatrix(opts.loader, opts.mcVersion, opts.minConflicts ?? 2) as {
        totalMixinMods: number; totalTargetClasses: number; conflictingClasses: number;
        mostConflictedMods: Array<{ modId: string; conflictingClasses: number }>;
        conflicts: Array<{ class: string; mixedByCount: number; mods: Array<{ modId: string; display: string; version: string }> }>;
    };

    let md = h1("Mixin Conflict Report");
    md += `${timestamp()}\n`;
    if (opts.loader) md += `Loader filter: ${code(opts.loader)}\n`;
    if (opts.mcVersion) md += `MC version filter: ${code(opts.mcVersion)}\n`;

    md += h2("Summary");
    md += `- Total mods with mixins: ${bold(String(data.totalMixinMods))}\n`;
    md += `- Unique target classes: ${bold(String(data.totalTargetClasses))}\n`;
    md += `- Classes targeted by 2+ mods: ${bold(String(data.conflictingClasses))}\n`;

    if (data.mostConflictedMods.length > 0) {
        md += h2("Most Conflicted Mods");
        md += tableHeader(["Mod", "Conflicting Classes"]);
        for (const m of data.mostConflictedMods) {
            md += "\n" + tableRow([code(m.modId), String(m.conflictingClasses)]);
        }
        md += "\n";
    }

    md += h2(`Conflict Details (${data.conflicts.length} classes)`);
    for (const conflict of data.conflicts) {
        md += h3(code(conflict.class));
        md += `Mixed by ${bold(String(conflict.mixedByCount))} mods:\n\n`;
        md += tableHeader(["Mod", "Display Name", "Version"]);
        for (const m of conflict.mods) {
            md += "\n" + tableRow([code(m.modId), m.display, m.version]);
        }
        md += "\n";
    }

    return md;
}

async function reportTagConflicts(opts: { registry?: string }): Promise<string> {
    const data = await findTagConflicts(opts.registry) as {
        hardConflicts: { count: number; conflicts: Array<{ tagPath: string; registry: string; conflictingMods: Array<{ mod: string; display: string; version: string; entries: string[] }> }> };
        softConflicts: { count: number; conflicts: Array<{ tagPath: string; registry: string; replacer: string; silencedMods: string[] }> };
    };

    let md = h1("Tag Conflict Report");
    md += `${timestamp()}\n`;
    if (opts.registry) md += `Registry filter: ${code(opts.registry)}\n`;

    md += h2("Summary");
    md += `- Hard conflicts (multiple replace:true): ${bold(String(data.hardConflicts.count))}\n`;
    md += `- Soft conflicts (one mod silences others): ${bold(String(data.softConflicts.count))}\n`;

    if (data.hardConflicts.count > 0) {
        md += h2("Hard Conflicts");
        md += `> These tags have **multiple mods** all setting \`replace: true\`. The last mod loaded wins, silencing all others.\n`;
        for (const c of data.hardConflicts.conflicts) {
            md += h3(code(c.tagPath) + ` (${c.registry})`);
            md += tableHeader(["Mod", "Entries"]);
            for (const m of c.conflictingMods) {
                md += "\n" + tableRow([code(m.mod), m.entries.slice(0, 5).join(", ") + (m.entries.length > 5 ? " …" : "")]);
            }
            md += "\n";
        }
    }

    if (data.softConflicts.count > 0) {
        md += h2("Soft Conflicts");
        md += `> These tags have one mod with \`replace: true\` — it silently overwrites the contributions of other mods.\n`;
        md += tableHeader(["Tag", "Registry", "Replacer (wins)", "Silenced Mods"]);
        for (const c of data.softConflicts.conflicts) {
            md += "\n" + tableRow([code(c.tagPath), c.registry, code(c.replacer), c.silencedMods.map(code).join(", ")]);
        }
        md += "\n";
    }

    return md;
}

async function reportVersionConflicts(): Promise<string> {
    const data = await findVersionConflicts() as {
        duplicateModIds: { count: number; mods: Array<{ modId: string; display: string; ingestedVersions: Array<{ version: string; mcVersion: string; loader: string; dbId: number }> }> };
        unsatisfiedDeps: { count: number; deps: Array<{ declaredBy: string; depId: string; requiredRange: string; foundVersions: string[]; required: boolean }> };
    };

    let md = h1("Version Conflict Report");
    md += `${timestamp()}\n`;

    md += h2("Duplicate Mod IDs in DB");
    md += `${data.duplicateModIds.count} mod ID(s) have multiple ingested versions.\n`;
    if (data.duplicateModIds.count > 0) {
        for (const m of data.duplicateModIds.mods) {
            md += h3(code(m.modId) + ` — ${m.display}`);
            md += tableHeader(["Version", "MC Version", "Loader", "DB ID"]);
            for (const v of m.ingestedVersions) {
                md += "\n" + tableRow([v.version, v.mcVersion, v.loader, String(v.dbId)]);
            }
            md += "\n";
        }
    }

    md += h2("Unsatisfied Dependency Ranges");
    md += `${data.unsatisfiedDeps.count} declared dep(s) where the ingested version may not satisfy the required range.\n`;
    if (data.unsatisfiedDeps.count > 0) {
        md += tableHeader(["Declared By", "Dependency", "Required Range", "Found Versions", "Required?"]);
        for (const d of data.unsatisfiedDeps.deps) {
            md += "\n" + tableRow([
                code(d.declaredBy), code(d.depId), code(d.requiredRange),
                d.foundVersions.join(", "), d.required ? "Yes" : "Optional",
            ]);
        }
        md += "\n";
    }

    return md;
}

async function reportModOverview(modIdOrDbId: string | number): Promise<string> {
    const mod = await resolveModRef(String(modIdOrDbId));
    if (!mod) return `# Error\nMod not found: ${modIdOrDbId}\n`;

    const meta = mod.metadata as Record<string, string> | null;
    const mixinTargets = (mod.mixinTargets as string[]) ?? [];
    const deps = (mod.dependencies as Array<{ id: string; version: string; required: boolean }>) ?? [];
    const tags = await findModTagsByMod(mod.id);

    let md = h1(`Mod Overview: ${mod.displayName}`);
    md += `${timestamp()}\n`;

    md += h2("Identity");
    md += `| Field | Value |\n|---|---|\n`;
    md += `| Mod ID | ${code(mod.modId)} |\n`;
    md += `| Version | ${mod.version} |\n`;
    md += `| MC Version | ${mod.mcVersion} |\n`;
    md += `| Loader | ${mod.loader} |\n`;
    md += `| Source URL | ${meta?.sourceUrl ? `[link](${meta.sourceUrl})` : "—"} |\n`;
    md += `| Modrinth | ${meta?.modrinthSlug ? `[${meta.modrinthSlug}](https://modrinth.com/mod/${meta.modrinthSlug})` : "—"} |\n`;
    md += `| Has Mixins | ${mod.hasMixins ? "Yes" : "No"} |\n`;
    md += `| Has AT | ${mod.hasAt ? "Yes" : "No"} |\n`;
    md += `| Has AW | ${mod.hasAw ? "Yes" : "No"} |\n`;

    if (deps.length > 0) {
        md += h2(`Dependencies (${deps.length})`);
        md += tableHeader(["Mod ID", "Version Range", "Required"]);
        for (const d of deps) {
            md += "\n" + tableRow([code(d.id), code(d.version), d.required ? "Yes" : "Optional"]);
        }
        md += "\n";
    }

    if (mixinTargets.length > 0) {
        md += h2(`Mixin Targets (${mixinTargets.length})`);
        for (const t of mixinTargets) md += `- ${code(t)}\n`;
    }

    if (tags.length > 0) {
        md += h2(`Registered Tags (${tags.length})`);
        const byReg: Record<string, typeof tags> = {};
        for (const t of tags) (byReg[t.registry] ??= []).push(t);
        for (const [reg, tagList] of Object.entries(byReg)) {
            md += h3(reg);
            md += tableHeader(["Tag Path", "Replace", "Entry Count"]);
            for (const t of tagList) {
                md += "\n" + tableRow([code(`#${t.tagPath}`), t.replace ? "⚠️ Yes" : "No", String(t.entries.length)]);
            }
            md += "\n";
        }
    }

    return md;
}

async function reportGradleDeps(opts: { groupFilter?: string; modIdFilter?: string }): Promise<string> {
    const data = await compareGradleDeps(opts.groupFilter, opts.modIdFilter) as {
        totalDependencies: number;
        dependencies: Array<{
            dependency: string; usedBy: number; versionConflict: boolean;
            users: Array<{ mod: string; config: string; version: string }>;
        }>;
    };

    let md = h1("Gradle Dependency Comparison");
    md += `${timestamp()}\n`;
    if (opts.groupFilter) md += `Group filter: ${code(opts.groupFilter)}\n`;
    if (opts.modIdFilter) md += `Mod filter: ${code(opts.modIdFilter)}\n`;
    md += `\nTotal unique dependencies found: ${bold(String(data.totalDependencies))}\n`;

    const conflicts = data.dependencies.filter((d) => d.versionConflict);
    if (conflicts.length > 0) {
        md += h2(`Version Conflicts (${conflicts.length})`);
        for (const dep of conflicts) {
            md += h3(code(dep.dependency));
            md += tableHeader(["Mod", "Config", "Version"]);
            for (const u of dep.users) {
                md += "\n" + tableRow([code(u.mod), u.config, u.version]);
            }
            md += "\n";
        }
    }

    md += h2("All Dependencies");
    md += tableHeader(["Dependency", "Used By", "Version Conflict"]);
    for (const dep of data.dependencies) {
        md += "\n" + tableRow([code(dep.dependency), String(dep.usedBy), dep.versionConflict ? "⚠️ Yes" : "No"]);
    }
    md += "\n";

    return md;
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

export type ReportType =
    | "mixin_conflicts"
    | "tag_conflicts"
    | "version_conflicts"
    | "mod_overview"
    | "gradle_deps"
    | "pack_compat"
    | "dep_graph"
    | "sidedness"
    | "mod_complexity"
    | "pack_changelog";

async function reportPackCompat(opts: { mcVersion?: string; loader?: string; dbIds?: number[] }): Promise<string> {
    // Run all relevant checks concurrently
    const degradedWhere: Record<string, unknown> = {
        metadataSource: { in: ["filename", "@Mod annotation"] },
    };
    if (opts.mcVersion) degradedWhere.mcVersion = { contains: opts.mcVersion };
    if (opts.loader) degradedWhere.loader = opts.loader;
    const db = await getDb();

    const [versionData, atawData, mixinData, tagData, degradedMods] = await Promise.all([
        findVersionConflicts({ mcVersion: opts.mcVersion, loader: opts.loader }) as Promise<{
            duplicateModIds: { count: number; mods: Array<{ modId: string; display: string; ingestedVersions: Array<{ version: string; mcVersion: string; loader: string; dbId: number }> }> };
            unsatisfiedDeps: { count: number; deps: Array<{ declaredBy: string; depId: string; requiredRange: string; foundVersions: string[]; required: boolean }> };
        }>,
        findAtAwConflicts(opts.mcVersion, opts.loader) as Promise<{
            accessConflicts: Array<{ target: string; modCount: number; users: Array<{ mod: string; access: string }> }>;
            sharedTargets: Array<{ target: string; modCount: number }>;
            totalModsWithAt: number; totalModsWithAw: number;
        }>,
        getMixinConflictMatrix(opts.loader, opts.mcVersion, 2) as Promise<{
            conflictingClasses: number;
            conflicts: Array<{ class: string; mixedByCount: number; mods: Array<{ modId: string; version: string }> }>;
        }>,
        _ftc(undefined) as Promise<{
            hardConflicts: { count: number; conflicts: Array<{ tagPath: string; registry: string; conflictingMods: Array<{ mod: string }> }> };
            softConflicts: { count: number };
        }>,
        db.mod.findMany({
            where: degradedWhere,
            select: { modId: true, displayName: true, jarPath: true, metadataSource: true },
            orderBy: { modId: "asc" },
        }),
    ]);

    let md = h1("Pack Compatibility Report");
    md += `${timestamp()}\n`;
    if (opts.mcVersion) md += `MC version: ${code(opts.mcVersion)}\n`;
    if (opts.loader) md += `Loader: ${code(opts.loader)}\n`;

    // ── Summary scorecard
    const issues = [
        versionData.duplicateModIds.count > 0 ? `${versionData.duplicateModIds.count} duplicate mod ID(s)` : null,
        versionData.unsatisfiedDeps.count > 0 ? `${versionData.unsatisfiedDeps.count} unsatisfied dep(s)` : null,
        mixinData.conflictingClasses > 0 ? `${mixinData.conflictingClasses} mixin-conflicted class(es)` : null,
        tagData.hardConflicts.count > 0 ? `${tagData.hardConflicts.count} hard tag conflict(s)` : null,
        degradedMods.length > 0 ? `${degradedMods.length} mod(s) with degraded metadata` : null,
    ].filter(Boolean);

    md += h2("Scorecard");
    if (issues.length === 0) {
        md += `✅ No issues detected.\n`;
    } else {
        md += `⚠️ ${issues.length} issue category(ies) found:\n\n`;
        for (const i of issues) md += `- ${i}\n`;
    }

    // ── Duplicate mod IDs
    if (versionData.duplicateModIds.count > 0) {
        md += h2("Duplicate Mod IDs");
        for (const m of versionData.duplicateModIds.mods) {
            md += `- ${code(m.modId)}: ${m.ingestedVersions.map(v => v.version).join(", ")}\n`;
        }
    }

    // ── Unsatisfied deps (required only)
    const requiredUnsatisfied = versionData.unsatisfiedDeps.deps.filter(d => d.required);
    if (requiredUnsatisfied.length > 0) {
        md += h2("Unsatisfied Required Dependencies");
        md += tableHeader(["Declared By", "Needs", "Range", "Found"]);
        for (const d of requiredUnsatisfied) {
            md += "\n" + tableRow([code(d.declaredBy), code(d.depId), code(d.requiredRange), d.foundVersions.join(", ") || "—"]);
        }
        md += "\n";
    }

    // ── AT/AW shared targets (informational — AT/AW only ever widens access, never narrows)
    if (atawData.accessConflicts.length > 0) {
        md += h2("AT/AW Shared Targets (informational)");
        md += `> Multiple mods target the same member with different access keywords. AT/AW always resolves to the most permissive level — these are **not** runtime risks.\n`;
        md += tableHeader(["Target", "Mods (access)"]);
        for (const c of atawData.accessConflicts.slice(0, 20)) {
            const mods = c.users.map((u: { mod: string; access: string }) => `${code(u.mod)} (${u.access})`).join(", ");
            md += "\n" + tableRow([code(c.target), mods]);
        }
        md += "\n";
        if (atawData.accessConflicts.length > 20) md += `_…and ${atawData.accessConflicts.length - 20} more. Run \`mod_mixins action=at_conflicts\` for full list._\n`;
    }

    // ── Mixin conflicts (top 10)
    if (mixinData.conflictingClasses > 0) {
        md += h2(`Mixin Conflicts (${mixinData.conflictingClasses} classes)`);
        md += `> Only showing top 10 most-targeted classes. Run \`reports report=mixin_conflicts\` for full list.\n`;
        const top10 = mixinData.conflicts.slice(0, 10);
        md += tableHeader(["MC Class", "# Mods", "Mods"]);
        for (const c of top10) {
            md += "\n" + tableRow([code(c.class), String(c.mixedByCount), c.mods.map(m => code(m.modId)).join(", ")]);
        }
        md += "\n";
    }

    // ── Tag hard conflicts (top 10)
    if (tagData.hardConflicts.count > 0) {
        md += h2(`Tag Hard Conflicts (${tagData.hardConflicts.count})`);
        const top10 = tagData.hardConflicts.conflicts.slice(0, 10);
        md += tableHeader(["Tag", "Registry", "Competing Mods"]);
        for (const c of top10) {
            md += "\n" + tableRow([code(c.tagPath), c.registry, c.conflictingMods.map(m => code(m.mod)).join(", ")]);
        }
        md += "\n";
        if (tagData.hardConflicts.count > 10) md += `_…and ${tagData.hardConflicts.count - 10} more. Run \`reports report=tag_conflicts\` for full list._\n`;
    }

    // ── Degraded metadata
    if (degradedMods.length > 0) {
        md += h2(`Degraded Metadata (${degradedMods.length} mods)`);
        md += `> These mods had no standard manifest and were identified by ${bold("filename")} or ${bold("@Mod annotation")} — their modId, version, and dependencies may be inaccurate.\n\n`;
        md += tableHeader(["Mod", "Source", "JAR"]);
        for (const m of degradedMods) {
            const jar = m.jarPath.split(/[\\/]/).pop() ?? m.jarPath;
            md += "\n" + tableRow([code(m.modId), code(m.metadataSource ?? "unknown"), code(jar)]);
        }
        md += "\n";
    }

    return md;
}

async function reportDepGraph(opts: { mcVersion?: string; modId?: string | number }): Promise<string> {
    const graphData = await getDependencyGraph(opts.mcVersion) as {
        mcVersion: string;
        modCount: number;
        graph: Record<string, { requires: Array<{ id: string; version: string; required: boolean }>; requiredBy: string[] }>;
    };

    let md = h1("Dependency Graph Report");
    md += `${timestamp()}\n`;
    if (opts.mcVersion) md += `MC version filter: ${code(opts.mcVersion)}\n`;
    md += `\nMods in graph: ${bold(String(graphData.modCount))}\n`;

    // Mermaid diagram (cap at 40 mods to keep it readable)
    const entries = Object.entries(graphData.graph);
    md += h2("Mermaid Dependency Diagram");
    const subset = opts.modId
        ? entries.filter(([id]) => String(id).includes(String(opts.modId)))
        : entries.slice(0, 40);

    if (subset.length > 0) {
        md += "```mermaid\nflowchart LR\n";
        const nodeIds = new Set<string>();
        const addNode = (id: string) => {
            if (nodeIds.has(id)) return;
            nodeIds.add(id);
            // sanitize id for mermaid
            const safe = id.replace(/[^a-zA-Z0-9_]/g, "_");
            md += `    ${safe}["${id}"]\n`;
        };
        const edges: string[] = [];
        for (const [id, info] of subset) {
            addNode(id);
            for (const dep of info.requires) {
                if (dep.id === "minecraft" || dep.id === "neoforge" || dep.id === "forge" || dep.id === "fabricloader") continue;
                addNode(dep.id);
                const safeFrom = id.replace(/[^a-zA-Z0-9_]/g, "_");
                const safeTo   = dep.id.replace(/[^a-zA-Z0-9_]/g, "_");
                const style    = dep.required ? "-->" : "-.->";
                edges.push(`    ${safeFrom} ${style} ${safeTo}`);
            }
        }
        md += edges.join("\n") + "\n```\n";
        if (entries.length > 40 && !opts.modId) {
            md += `_Diagram shows first 40 of ${entries.length} mods. Use modId to filter._\n`;
        }
    } else {
        md += "_No matching mods in graph._\n";
    }

    // Textual detail
    md += h2("Dependency Details");
    md += tableHeader(["Mod", "Requires (required)", "Requires (optional)", "Required By"]);
    const fullList = opts.modId ? subset : entries;
    for (const [id, info] of fullList) {
        const req  = info.requires.filter(d => d.required).map(d => code(d.id)).join(", ") || "—";
        const opt  = info.requires.filter(d => !d.required).map(d => code(d.id)).join(", ") || "—";
        const reqBy = info.requiredBy.map(code).join(", ") || "—";
        md += "\n" + tableRow([code(id), req, opt, reqBy]);
    }
    md += "\n";

    // Orphans (no deps, not depended on)
    const orphans = entries.filter(([, info]) =>
        info.requires.filter(d => d.id !== "minecraft" && d.id !== "neoforge" && d.id !== "forge" && d.id !== "fabricloader").length === 0
        && info.requiredBy.length === 0
    ).map(([id]) => id);
    if (orphans.length > 0) {
        md += h2(`Standalone Mods (no declared inter-mod deps) — ${orphans.length}`);
        md += orphans.map(code).join(", ") + "\n";
    }

    return md;
}

async function reportSidedness(opts: { mcVersion?: string; loader?: string }): Promise<string> {
    const data = await analyzePackSidedness(opts.mcVersion, opts.loader) as {
        mcVersion: string; loader: string;
        summary: { client_only: number; server_only: number; client_optional: number; common: number; unknown: number; total: number };
        note: string;
        grouped: Record<string, Array<{ mod: string; display: string; version: string; source: string; evidence: string }>>;
    };

    let md = h1("Mod Sidedness Report");
    md += `${timestamp()}\n`;
    if (opts.mcVersion) md += `MC version: ${code(opts.mcVersion)}\n`;
    if (opts.loader)    md += `Loader: ${code(opts.loader)}\n`;

    md += h2("Summary");
    md += `| Category | Count |\n|---|---|\n`;
    md += `| Client-only (safe to remove from server) | ${bold(String(data.summary.client_only))} |\n`;
    md += `| Client-optional (not required on server)  | ${bold(String(data.summary.client_optional))} |\n`;
    md += `| Common (required on both sides)           | ${bold(String(data.summary.common))} |\n`;
    md += `| Server-only (not needed on client)        | ${bold(String(data.summary.server_only))} |\n`;
    md += `| Unknown                                   | ${bold(String(data.summary.unknown))} |\n`;
    md += `| **Total**                                 | ${bold(String(data.summary.total))} |\n\n`;
    md += `> ${data.note}\n`;

    for (const [category, mods] of Object.entries(data.grouped)) {
        if (mods.length === 0) continue;
        const label = category === "client_only"     ? "Client-Only Mods"
                    : category === "client_optional" ? "Client-Optional Mods"
                    : category === "server_only"     ? "Server-Only Mods"
                    : category === "common"          ? "Common Mods (required both sides)"
                    : "Unknown Sidedness";
        md += h2(`${label} (${mods.length})`);
        md += tableHeader(["Mod", "Version", "Detection Source", "Evidence"]);
        for (const m of mods) {
            md += "\n" + tableRow([code(m.mod), m.version, m.source, m.evidence]);
        }
        md += "\n";
    }
    return md;
}

async function reportModComplexity(opts: { mcVersion?: string; loader?: string }): Promise<string> {
    const data = await computeModComplexity(opts.mcVersion, opts.loader) as {
        mcVersion: string; loader: string; note: string;
        mods: Array<{ mod: string; display: string; version: string; loader: string; classCount: number; mixinCount: number; atCount: number; awCount: number; score: number }>;
    };

    let md = h1("Mod Complexity Report");
    md += `${timestamp()}\n`;
    if (opts.mcVersion) md += `MC version: ${code(opts.mcVersion)}\n`;
    if (opts.loader)    md += `Loader: ${code(opts.loader)}\n`;
    md += `\n> ${data.note}\n`;

    md += h2(`Complexity Rankings (${data.mods.length} mods, highest first)`);
    md += tableHeader(["Rank", "Mod", "Version", "Score", "Classes", "Mixin Targets", "AT Entries", "AW Entries"]);
    for (let i = 0; i < data.mods.length; i++) {
        const m = data.mods[i];
        md += "\n" + tableRow([String(i + 1), code(m.mod), m.version, bold(String(m.score)), String(m.classCount), String(m.mixinCount), String(m.atCount), String(m.awCount)]);
    }
    md += "\n";

    // Top-5 callout
    const top5 = data.mods.slice(0, 5);
    if (top5.length > 0) {
        md += h2("Top 5 Heaviest Mods");
        md += `These mods have the largest class-transformer / mixin footprint:\n\n`;
        for (const m of top5) {
            md += `- ${bold(code(m.mod))} — score ${bold(String(m.score))}: ${m.classCount} classes, ${m.mixinCount} mixin targets, ${m.atCount + m.awCount} AT/AW entries\n`;
        }
    }
    return md;
}

async function reportPackChangelog(opts: { oldIds?: number[]; newIds?: number[] }): Promise<string> {
    if (!opts.oldIds?.length || !opts.newIds?.length) {
        return "# Pack Changelog\n\nError: both oldIds and newIds are required.\n";
    }
    const data = await computePackChangelog(opts.oldIds, opts.newIds) as {
        summary: { added: number; removed: number; updated: number };
        oldPackSize: number; newPackSize: number;
        added:   Array<{ mod: string; display: string; version: string }>;
        removed: Array<{ mod: string; display: string; version: string }>;
        updated: Array<{ mod: string; display: string; oldVersion: string; newVersion: string }>;
    };

    let md = h1("Pack Changelog");
    md += `${timestamp()}\n`;
    md += `\nOld pack: ${bold(String(data.oldPackSize))} mods → New pack: ${bold(String(data.newPackSize))} mods\n`;
    md += h2("Summary");
    md += `- ✅ Added: ${bold(String(data.summary.added))}\n`;
    md += `- ❌ Removed: ${bold(String(data.summary.removed))}\n`;
    md += `- 🔄 Updated: ${bold(String(data.summary.updated))}\n`;

    if (data.added.length > 0) {
        md += h2(`Added Mods (${data.added.length})`);
        md += tableHeader(["Mod", "Display Name", "Version"]);
        for (const m of data.added) md += "\n" + tableRow([code(m.mod), m.display, m.version]);
        md += "\n";
    }
    if (data.removed.length > 0) {
        md += h2(`Removed Mods (${data.removed.length})`);
        md += tableHeader(["Mod", "Display Name", "Last Version"]);
        for (const m of data.removed) md += "\n" + tableRow([code(m.mod), m.display, m.version]);
        md += "\n";
    }
    if (data.updated.length > 0) {
        md += h2(`Updated Mods (${data.updated.length})`);
        md += tableHeader(["Mod", "Display Name", "Old Version", "New Version"]);
        for (const m of data.updated) md += "\n" + tableRow([code(m.mod), m.display, m.oldVersion, m.newVersion]);
        md += "\n";
    }
    return md;
}

export async function generateReport(opts: {
    report: ReportType;
    savePath?: string;
    // per-report options
    modId?: string | number;
    loader?: string;
    mcVersion?: string;
    registry?: string;
    minConflicts?: number;
    groupFilter?:  string;
    modIdFilter?:  string;
    dbIds?:        number[];
    oldIds?:       number[];
    newIds?:       number[];
}): Promise<{ markdown: string; savedTo?: string }> {
    let markdown: string;

    switch (opts.report) {
        case "mixin_conflicts":
            markdown = await reportMixinConflicts({ loader: opts.loader, mcVersion: opts.mcVersion, minConflicts: opts.minConflicts });
            break;
        case "tag_conflicts":
            markdown = await reportTagConflicts({ registry: opts.registry });
            break;
        case "version_conflicts":
            markdown = await reportVersionConflicts();
            break;
        case "mod_overview":
            if (!opts.modId) throw new Error("modId required for mod_overview report");
            markdown = await reportModOverview(opts.modId);
            break;
        case "gradle_deps":
            markdown = await reportGradleDeps({ groupFilter: opts.groupFilter, modIdFilter: opts.modIdFilter });
            break;
        case "pack_compat":
            markdown = await reportPackCompat({ mcVersion: opts.mcVersion, loader: opts.loader, dbIds: opts.dbIds });
            break;
        case "dep_graph":
            markdown = await reportDepGraph({ mcVersion: opts.mcVersion, modId: opts.modId });
            break;
        case "sidedness":
            markdown = await reportSidedness({ mcVersion: opts.mcVersion, loader: opts.loader });
            break;
        case "mod_complexity":
            markdown = await reportModComplexity({ mcVersion: opts.mcVersion, loader: opts.loader });
            break;
        case "pack_changelog":
            markdown = await reportPackChangelog({ oldIds: opts.oldIds, newIds: opts.newIds });
            break;
        default:
            throw new Error(`Unknown report type: ${(opts as { report: string }).report}`);
    }

    let savedTo: string | undefined;
    if (opts.savePath) {
        await mkdir(dirname(opts.savePath), { recursive: true });
        await writeFile(opts.savePath, markdown, "utf8");
        savedTo = opts.savePath;
    }

    return { markdown, savedTo };
}
