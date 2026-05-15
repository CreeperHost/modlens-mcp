/**
 * Gradle build file search tools.
 *
 * Scans decompiled/source mod directories for build.gradle / build.gradle.kts files
 * and lets you query them — find dependencies, plugins, repositories, and custom
 * blocks across multiple mods' build scripts.
 */
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { db } from "../db.js";
import { exists } from "../cache.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findGradleFiles(rootDir: string): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string, depth = 0) => {
        if (depth > 4) return; // don't recurse too deep
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory() && !["node_modules", ".git", "build", "out"].includes(e.name)) {
                await walk(full, depth + 1);
            } else if (e.isFile() && (e.name === "build.gradle" || e.name === "build.gradle.kts" || e.name === "settings.gradle" || e.name === "settings.gradle.kts")) {
                results.push(full);
            }
        }
    };
    await walk(rootDir);
    return results;
}

function extractDepsFromGradle(content: string): Array<{ config: string; notation: string }> {
    const deps: Array<{ config: string; notation: string }> = [];
    // Match: implementation("group:artifact:version") or implementation 'g:a:v'
    const re = /(\w+)\s*[\(]?\s*["']([^"'\n]+:[^"'\n]+:[^"'\n]+)["']\s*[\)]?/g;
    for (const m of content.matchAll(re)) {
        const config = m[1];
        // Filter to known gradle configs only
        if (["implementation","api","compileOnly","runtimeOnly","testImplementation","modImplementation","jarJar","include","forgeRuntime"].includes(config)) {
            deps.push({ config, notation: m[2] });
        }
    }
    return deps;
}

function extractPluginsFromGradle(content: string): string[] {
    const plugins: string[] = [];
    // plugins { id("foo.bar") version "x" } or id 'foo.bar'
    const re = /id\s*[\(]?\s*["']([^"']+)["']/g;
    for (const m of content.matchAll(re)) plugins.push(m[1]);
    return [...new Set(plugins)];
}

function extractRepositoriesFromGradle(content: string): string[] {
    const repos: string[] = [];
    // maven { url = "..." } or url("...")
    const re = /url\s*[=(]?\s*["']?(https?:\/\/[^"'\s\)]+)["']?/g;
    for (const m of content.matchAll(re)) repos.push(m[1]);
    return [...new Set(repos)];
}

// ── Public tools ──────────────────────────────────────────────────────────────

/**
 * Get gradle build file contents for a specific mod.
 * Searches the mod's sourcePath and decompPath directories.
 */
export async function getModGradleFiles(modIdOrDbId: string | number): Promise<object> {
    const mod = typeof modIdOrDbId === "number" || !isNaN(Number(modIdOrDbId))
        ? await db().mod.findUnique({ where: { id: Number(modIdOrDbId) } })
        : await db().mod.findFirst({ where: { modId: String(modIdOrDbId) } });
    if (!mod) return { error: `Mod not found: ${modIdOrDbId}` };

    const searchDirs = [mod.sourcePath, mod.decompPath].filter(Boolean) as string[];
    if (searchDirs.length === 0) return { error: `No source or decompiled path for ${mod.modId}. Run download_source or decompile_mod first.` };

    const files: Array<{ path: string; content: string; dependencies: ReturnType<typeof extractDepsFromGradle>; plugins: string[]; repositories: string[] }> = [];

    for (const dir of searchDirs) {
        const gradleFiles = await findGradleFiles(dir);
        for (const gf of gradleFiles) {
            try {
                const content = await readFile(gf, "utf8");
                files.push({
                    path: gf.replace(dir, "").replace(/\\/g, "/"),
                    content,
                    dependencies: extractDepsFromGradle(content),
                    plugins: extractPluginsFromGradle(content),
                    repositories: extractRepositoriesFromGradle(content),
                });
            } catch { /* skip unreadable */ }
        }
    }

    return { mod: mod.modId, version: mod.version, fileCount: files.length, files };
}

/**
 * Search gradle files across all ingested mods for a pattern.
 * Returns matching lines with context.
 */
export async function searchGradleFiles(
    query: string,
    modIdFilter?: string,
    limit = 20,
): Promise<object> {
    const mods = await db().mod.findMany({
        where: {
            AND: [
                { OR: [{ sourcePath: { not: null } }, { decompPath: { not: null } }] },
                ...(modIdFilter ? [{ modId: { contains: modIdFilter, mode: "insensitive" as const } }] : []),
            ],
        },
        select: { id: true, modId: true, displayName: true, version: true, sourcePath: true, decompPath: true },
    });

    const results: Array<{ mod: string; file: string; lineNumber: number; line: string; context: string[] }> = [];
    const lowerQuery = query.toLowerCase();

    for (const mod of mods) {
        if (results.length >= limit) break;
        const dirs = [mod.sourcePath, mod.decompPath].filter(Boolean) as string[];
        for (const dir of dirs) {
            if (results.length >= limit) break;
            const gradleFiles = await findGradleFiles(dir);
            for (const gf of gradleFiles) {
                if (results.length >= limit) break;
                try {
                    const content = await readFile(gf, "utf8");
                    const lines = content.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(lowerQuery)) {
                            results.push({
                                mod:        mod.modId,
                                file:       gf.replace(dir, "").replace(/\\/g, "/"),
                                lineNumber: i + 1,
                                line:       lines[i].trim(),
                                context:    lines.slice(Math.max(0, i - 2), i + 3).map((l) => l.trimEnd()),
                            });
                            if (results.length >= limit) break;
                        }
                    }
                } catch { /* skip */ }
            }
        }
    }

    return { query, resultCount: results.length, results };
}

/**
 * Compare gradle dependencies across all mods — find who uses the same library,
 * who uses different versions, who has jarJar/embed vs. compileOnly, etc.
 */
export async function compareGradleDeps(
    groupFilter?: string,
    modIdFilter?: string,
): Promise<object> {
    const mods = await db().mod.findMany({
        where: {
            AND: [
                { OR: [{ sourcePath: { not: null } }, { decompPath: { not: null } }] },
                ...(modIdFilter ? [{ modId: { contains: modIdFilter, mode: "insensitive" as const } }] : []),
            ],
        },
        select: { id: true, modId: true, version: true, sourcePath: true, decompPath: true },
    });

    // notation → [{ mod, config, version }]
    const depMap: Record<string, Array<{ mod: string; config: string; version: string }>> = {};

    for (const mod of mods) {
        const dirs = [mod.sourcePath, mod.decompPath].filter(Boolean) as string[];
        for (const dir of dirs) {
            const gradleFiles = await findGradleFiles(dir);
            for (const gf of gradleFiles) {
                try {
                    const content = await readFile(gf, "utf8");
                    const deps = extractDepsFromGradle(content);
                    for (const dep of deps) {
                        const parts = dep.notation.split(":");
                        const key = parts.slice(0, 2).join(":"); // group:artifact
                        if (groupFilter && !key.toLowerCase().includes(groupFilter.toLowerCase())) continue;
                        (depMap[key] ??= []).push({
                            mod: mod.modId,
                            config: dep.config,
                            version: parts[2] ?? "?",
                        });
                    }
                } catch { /* skip */ }
            }
        }
    }

    // Sort: most-used first
    const sorted = Object.entries(depMap)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([dep, users]) => ({
            dependency: dep,
            usedBy: users.length,
            versionConflict: new Set(users.map((u) => u.version)).size > 1,
            users,
        }));

    return { groupFilter, totalDependencies: sorted.length, dependencies: sorted };
}
