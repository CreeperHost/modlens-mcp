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
import { db } from "../db.js";
import { getMixinConflictMatrix, getMixinHotspots, listModsWithMixins } from "./mixin-scan.js";
import { findTagConflicts, getTagContributors, getModTagList, searchModTags } from "./mod-tags.js";
import { findVersionConflicts, getDependencyGraph, listModSourceUrls } from "./catalog.js";
import { compareGradleDeps } from "./gradle.js";

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
    const mod = typeof modIdOrDbId === "number" || !isNaN(Number(modIdOrDbId))
        ? await db().mod.findUnique({ where: { id: Number(modIdOrDbId) } })
        : await db().mod.findFirst({ where: { modId: String(modIdOrDbId) } });
    if (!mod) return `# Error\nMod not found: ${modIdOrDbId}\n`;

    const meta = mod.metadata as Record<string, string> | null;
    const mixinTargets = (mod.mixinTargets as string[]) ?? [];
    const deps = (mod.dependencies as Array<{ id: string; version: string; required: boolean }>) ?? [];
    const tags = await db().modTag.findMany({
        where: { modId: mod.id },
        orderBy: [{ registry: "asc" }, { tagPath: "asc" }],
    });

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
    | "gradle_deps";

export async function generateReport(opts: {
    report: ReportType;
    savePath?: string;
    // per-report options
    modId?: string | number;
    loader?: string;
    mcVersion?: string;
    registry?: string;
    minConflicts?: number;
    groupFilter?: string;
    modIdFilter?: string;
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
