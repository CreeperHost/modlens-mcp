/**
 * Vanilla Minecraft analysis tools.
 * Covers: class search, decompile (single + bulk), bytecode, members,
 * references, inheritance, version diff, source search, AW validation,
 * and mixin validation.
 */
import { readFile, writeFile, readdir } from "fs/promises";
import { join, relative } from "path";
import { getMcJarPath, mcPaths, fetchMcVersionList } from "../minecraft.js";
import { listClasses } from "../jar.js";
import { safeRegex } from "../security.js";
import { validateVersion, validateClassName } from "../validate.js";
import { isMcVersionIndexed, searchMcIndexed } from "./mc-fts.js";
import { searchClasses } from "../search.js";
import { inspectClass, getBytecode, indexJar, decompileClass, decompileJar,
         isDecompileDone, decompileSentinelDone, type JarIndex } from "../java-tools.js";
import { exists, ensureDir } from "../cache.js";
import { formatClassMembers } from "../access-flags.js";
import { ensureMcVersion, updateMcVersion } from "../repositories/mcVersion.js";
import { findModByModIdLike } from "../repositories/mod.js";
import { searchSource } from "./source.js";

// ── Index cache (disk-backed per version, mirroring mcsrc's index-manager) ───

const indexMemCache = new Map<string, JarIndex>();

async function getMcIndex(version: string): Promise<JarIndex> {
    if (indexMemCache.has(version)) return indexMemCache.get(version)!;

    const cachePath = mcPaths.index(version);
    if (await exists(cachePath)) {
        const data = JSON.parse(await readFile(cachePath, "utf8")) as JarIndex;
        indexMemCache.set(version, data);
        return data;
    }

    const jarPath = await getMcJarPath(version);
    const index = await indexJar(jarPath);
    await ensureDir(cachePath);
    await writeFile(cachePath, JSON.stringify(index), "utf8");
    indexMemCache.set(version, index);
    return index;
}

// ── McVersion DB helper ───────────────────────────────────────────────────────

async function ensureMcVersionRecord(version: string): Promise<number> {
    return ensureMcVersion(version);
}

// ── Format helpers ────────────────────────────────────────────────────────────
// formatClassMembers is re-exported from access-flags.ts

// ── Similarity helper for validation suggestions ──────────────────────────────

function topSimilar(query: string, candidates: string[], n = 5): string[] {
    const q = query.toLowerCase();
    return candidates
        .map((c) => {
            const cl = c.toLowerCase();
            if (cl === q) return { c, score: 0 };
            if (cl.startsWith(q)) return { c, score: 1 };
            if (cl.includes(q)) return { c, score: 2 };
            // count shared chars
            let shared = 0;
            for (const ch of q) if (cl.includes(ch)) shared++;
            return { c, score: 10 - shared };
        })
        .filter((x) => x.score < 10)
        .sort((a, b) => a.score - b.score)
        .slice(0, n)
        .map((x) => x.c);
}

// ── Exported tool implementations ────────────────────────────────────────────

/** search_minecraft_class */
export async function searchMinecraftClass(version: string, query: string): Promise<string[]> {
    const jarPath = await getMcJarPath(version);
    const classes = listClasses(jarPath).map((c) => c.replace(/\.class$/, ""));
    return searchClasses(classes, query);
}

/** get_minecraft_source — decompile a single class with optional line-range slicing. */
export async function getMinecraftSource(
    version: string,
    className: string,
    startLine?: number,
    endLine?: number,
    maxLines?: number,
): Promise<string> {
    validateVersion(version);
    validateClassName(className);
    const internal = className.replace(/\./g, "/");
    const outDir = mcPaths.decompiled(version);
    const cached = mcPaths.classFile(version, internal);

    let source: string;
    if (await exists(cached)) {
        source = await readFile(cached, "utf8");
    } else {
        const jarPath = await getMcJarPath(version);
        source = await decompileClass(jarPath, internal, outDir);
    }

    if (startLine === undefined && endLine === undefined && maxLines === undefined) {
        return source.slice(0, 120_000); // cap at 120 KB
    }

    const lines = source.split("\n");
    const from = (startLine ?? 1) - 1;
    const to   = endLine ?? (from + (maxLines ?? 200));
    return lines.slice(from, to).join("\n");
}

/** get_mc_class_bytecode */
export async function getMcClassBytecode(version: string, className: string): Promise<string> {
    validateVersion(version);
    validateClassName(className);
    const jarPath = await getMcJarPath(version);
    return getBytecode(jarPath, className.replace(/\./g, "/"));
}

/** get_mc_class_members */
export async function getMcClassMembers(version: string, className: string) {
    validateVersion(version);
    validateClassName(className);
    const jarPath = await getMcJarPath(version);
    const info = await inspectClass(jarPath, className.replace(/\./g, "/"));
    return formatClassMembers(info);
}

/** find_mc_references */
export async function findMcReferences(version: string, target: string) {
    const index = await getMcIndex(version);
    const normalised = target.replace(/\./g, "/");

    const keysToTry = [
        `s:${normalised}`,
        `m:${normalised}`,
        `f:${normalised}`,
        normalised,
    ];

    const allRefs = new Set<string>();
    for (const key of keysToTry) {
        const refs = index.references[key];
        if (refs) refs.forEach((r) => allRefs.add(r));
    }

    return { target: normalised, count: allRefs.size, references: [...allRefs].sort() };
}

/** get_mc_inheritance */
export async function getMcInheritance(version: string, className: string) {
    const index = await getMcIndex(version);
    const internal = className.replace(/\./g, "/");
    const info = index.classes[internal];
    if (!info) throw new Error(`Class not found in index: ${internal}`);

    const classes = Object.values(index.classes);
    const subclasses  = classes.filter((c) => c.superName === internal).map((c) => c.name);
    const implementors = classes.filter((c) => c.interfaces?.includes(internal)).map((c) => c.name);

    return {
        className: internal,
        superClass: info.superName,
        interfaces: info.interfaces ?? [],
        subclasses,
        implementors,
    };
}

/** diff_minecraft_versions — added/removed classes between two versions. */
export async function diffMcVersions(versionA: string, versionB: string) {
    const [jarA, jarB] = await Promise.all([getMcJarPath(versionA), getMcJarPath(versionB)]);
    const setA = new Set(listClasses(jarA));
    const setB = new Set(listClasses(jarB));

    const added   = [...setB].filter((c) => !setA.has(c)).sort();
    const removed = [...setA].filter((c) => !setB.has(c)).sort();
    const common  = [...setA].filter((c) => setB.has(c)).length;

    return { versionA, versionB, summary: { added: added.length, removed: removed.length, common }, added, removed };
}

/** decompile_minecraft_version — background Vineflower decompile of the entire JAR. */
export async function decompileMcVersion(version: string, force = false) {
    const outDir = mcPaths.decompiled(version);
    const jarPath = await getMcJarPath(version);
    const dbId = await ensureMcVersionRecord(version);

    if (!force) {
        const status = await isDecompileDone(outDir);
        if (status === "done") {
            await updateMcVersion(dbId, { decompiled: true, decompPath: outDir });
            return { status: "already_done", outDir };
        }
        if (status === "running") return { status: "running", outDir };
    }

    await decompileJar(jarPath, outDir);
    await updateMcVersion(dbId, { decompPath: outDir, jarPath });
    return { status: "started", outDir };
}

/** Poll decompile status; marks DB record when done. */
export async function decompileMcVersionStatus(version: string) {
    const outDir = mcPaths.decompiled(version);
    const status = await isDecompileDone(outDir);

    if (status === "done") {
        const dbId = await ensureMcVersionRecord(version);
        await updateMcVersion(dbId, { decompiled: true, decompPath: outDir });
    }

    return { version, status, outDir };
}

/** search_minecraft_code — regex/text search over decompiled MC source files. */
export async function searchMcCode(
    version: string,
    query: string,
    searchType: "class" | "method" | "field" | "content" | "all",
    isRegex: boolean,
    limit: number,
): Promise<Array<{ file: string; line: number; text: string }>> {
    validateVersion(version);
    const outDir = mcPaths.decompiled(version);
    const status = await isDecompileDone(outDir);
    if (status !== "done") {
        throw new Error(
            `MC ${version} has not been fully decompiled. ` +
            `Run decompile_minecraft_version("${version}") first, then wait for it to finish.`
        );
    }

    // ── Fast path: use PostgreSQL FTS index when available ───────────────────
    // FTS only supports plain-text queries. For regex or type-scoped searches
    // (class/method/field), fall through to the filesystem walk.
    if (!isRegex && (searchType === "content" || searchType === "all")) {
        const indexed = await isMcVersionIndexed(version);
        if (indexed) {
            const ftsResults = await searchMcIndexed(query, version, limit);
            return ftsResults.map((r) => ({
                file: r.className + ".java",
                line: 0, // FTS returns snippets, not line numbers
                text: r.snippet,
            }));
        }
    }

    // Build effective regex based on searchType
    let effectiveQuery = query;
    if (!isRegex) {
        // Escape for plain text, but we still use our own logic below
        effectiveQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    let pattern: RegExp;
    switch (searchType) {
        case "class":
            pattern = safeRegex(`(?:class|interface|enum|record)\\s+.*${effectiveQuery}`, "i");
            break;
        case "method":
            pattern = safeRegex(`(?:public|protected|private|package-private|static|final|abstract|\\s)\\s+\\w[\\w<>\\[\\]]*\\s+${effectiveQuery}\\s*\\(`, "i");
            break;
        case "field":
            pattern = safeRegex(`(?:public|protected|private|static|final|volatile|transient|\\s)\\s+\\w[\\w<>\\[\\]]*\\s+${effectiveQuery}\\s*[=;]`, "i");
            break;
        case "content":
        case "all":
        default:
            pattern = safeRegex(effectiveQuery, "i");
    }

    const results: Array<{ file: string; line: number; text: string }> = [];
    await walkAndSearch(outDir, outDir, pattern, results, limit);
    return results;
}

async function walkAndSearch(
    base: string,
    dir: string,
    pattern: RegExp,
    results: Array<{ file: string; line: number; text: string }>,
    limit: number,
): Promise<void> {
    if (results.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (results.length >= limit) break;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkAndSearch(base, full, pattern, results, limit);
        } else if (entry.name.endsWith(".java")) {
            const content = await readFile(full, "utf8").catch(() => "");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && results.length < limit; i++) {
                if (pattern.test(lines[i])) {
                    results.push({ file: relative(base, full), line: i + 1, text: lines[i].trim().slice(0, 200) });
                }
            }
        }
    }
}

// ── validate_access_widener ───────────────────────────────────────────────────

interface AwEntry {
    line: number;
    raw: string;
    kind: "class" | "method" | "field";
    access: string;
    className: string;
    memberName?: string;
    descriptor?: string;
}

function parseAwContent(content: string): AwEntry[] {
    const entries: AwEntry[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw || raw.startsWith("#") || raw.startsWith("accessWidener")) continue;
        const parts = raw.split(/\s+/);
        if (parts.length < 3) continue;
        const [access, kind, className] = parts;
        if (kind === "class") {
            entries.push({ line: i + 1, raw, kind: "class", access, className });
        } else if (kind === "method" && parts.length >= 5) {
            // format: <access> method <class> <name> <descriptor>
            entries.push({ line: i + 1, raw, kind: "method", access, className, memberName: parts[3], descriptor: parts[4] });
        } else if (kind === "field" && parts.length >= 5) {
            entries.push({ line: i + 1, raw, kind: "field", access, className, memberName: parts[3], descriptor: parts[4] });
        }
    }
    return entries;
}

export async function validateAccessWidener(content: string, mcVersion: string) {
    const entries = parseAwContent(content);
    const errors: Array<{ line: number; raw: string; error: string; suggestions?: string[] }> = [];
    const valid: AwEntry[] = [];

    // Group by class to minimise inspectClass calls
    const byClass = new Map<string, AwEntry[]>();
    for (const e of entries) {
        const list = byClass.get(e.className) ?? [];
        list.push(e);
        byClass.set(e.className, list);
    }

    const jarPath = await getMcJarPath(mcVersion);

    for (const [className, classEntries] of byClass) {
        let members: ReturnType<typeof formatClassMembers> | null = null;
        try {
            const info = await inspectClass(jarPath, className);
            members = formatClassMembers(info);
        } catch {
            for (const e of classEntries) {
                const allClasses = listClasses(jarPath).map((c) => c.replace(/\.class$/, ""));
                errors.push({
                    line: e.line,
                    raw: e.raw,
                    error: `Class not found: ${className}`,
                    suggestions: topSimilar(className.split("/").pop() ?? className, allClasses.map((c) => c.split("/").pop() ?? c)),
                });
            }
            continue;
        }

        for (const e of classEntries) {
            if (e.kind === "class") {
                valid.push(e);
                continue;
            }
            if (e.kind === "method") {
                const methodNames = members.methods.map((m) => m.name);
                const match = members.methods.find(
                    (m) => m.name === e.memberName && (!e.descriptor || m.descriptor === e.descriptor)
                );
                if (match) {
                    valid.push(e);
                } else {
                    errors.push({
                        line: e.line,
                        raw: e.raw,
                        error: `Method not found: ${e.memberName} ${e.descriptor ?? "(any descriptor)"} in ${className}`,
                        suggestions: topSimilar(e.memberName ?? "", methodNames),
                    });
                }
            } else if (e.kind === "field") {
                const fieldNames = members.fields.map((f) => f.name);
                const match = members.fields.find(
                    (f) => f.name === e.memberName && (!e.descriptor || f.descriptor === e.descriptor)
                );
                if (match) {
                    valid.push(e);
                } else {
                    errors.push({
                        line: e.line,
                        raw: e.raw,
                        error: `Field not found: ${e.memberName} ${e.descriptor ?? "(any descriptor)"} in ${className}`,
                        suggestions: topSimilar(e.memberName ?? "", fieldNames),
                    });
                }
            }
        }
    }

    return {
        total: entries.length,
        valid: valid.length,
        errorCount: errors.length,
        errors,
        validEntries: valid.map((e) => e.raw),
    };
}

// ── analyze_mixin ─────────────────────────────────────────────────────────────

interface MixinInjection {
    annotationType: string;  // @Inject | @Redirect | @ModifyArg | @Overwrite | @Shadow
    method: string;
    at?: string;
    sourceLine?: number;
}

function parseMixinAnnotations(source: string): {
    targetClass: string | null;
    targetRaw: string;
    injections: MixinInjection[];
    shadows: string[];
    imports: Map<string, string>;
} {
    // Build import map: "LivingEntity" → "net/minecraft/world/entity/LivingEntity"
    const imports = new Map<string, string>();
    for (const m of source.matchAll(/^import\s+([\w.]+);/gm)) {
        const parts = m[1].split(".");
        imports.set(parts[parts.length - 1], m[1].replace(/\./g, "/"));
    }

    // Find @Mixin annotation
    let targetClass: string | null = null;
    let targetRaw = "";

    // @Mixin(targets = "net/minecraft/X")
    const targetsStr = source.match(/@Mixin\s*\(\s*targets\s*=\s*"([^"]+)"/);
    if (targetsStr) {
        targetClass = targetsStr[1].replace(/\./g, "/");
        targetRaw = targetsStr[0];
    }

    // @Mixin(SomeClass.class) or @Mixin(value = SomeClass.class)
    if (!targetClass) {
        const valueMatch = source.match(/@Mixin\s*\(\s*(?:value\s*=\s*)?(\w+)\.class/);
        if (valueMatch) {
            const simpleName = valueMatch[1];
            targetClass = imports.get(simpleName) ?? simpleName;
            targetRaw = valueMatch[0];
        }
    }

    // Extract @Inject / @Redirect / @ModifyArg method targets
    const injections: MixinInjection[] = [];
    const injectAnnotations = [
        { name: "@Inject",    re: /@Inject\s*\([^)]*method\s*=\s*"([^"]+)"[^)]*(?:at\s*=\s*@At\s*\(\s*"([^"]+)"\s*\))?[^)]*\)/gs },
        { name: "@Redirect",  re: /@Redirect\s*\([^)]*method\s*=\s*"([^"]+)"[^)]*\)/gs },
        { name: "@ModifyArg", re: /@ModifyArg\s*\([^)]*method\s*=\s*"([^"]+)"[^)]*\)/gs },
        { name: "@ModifyConstant", re: /@ModifyConstant\s*\([^)]*method\s*=\s*"([^"]+)"[^)]*\)/gs },
    ];

    for (const { name, re } of injectAnnotations) {
        for (const m of source.matchAll(re)) {
            injections.push({ annotationType: name, method: m[1], at: m[2] });
        }
    }

    // @Overwrite — the target method IS the method being declared
    for (const m of source.matchAll(/@Overwrite[\s\S]*?(?:public|protected|private)\s+\w[\w<>\[\]]*\s+(\w+)\s*\(/gm)) {
        injections.push({ annotationType: "@Overwrite", method: m[1] });
    }

    // @Shadow declarations
    const shadows: string[] = [];
    for (const m of source.matchAll(/@Shadow[^;{]*(?:private|protected|public)?\s+\w[\w<>\[\]]*\s+(\w+)/g)) {
        shadows.push(m[1]);
    }

    return { targetClass, targetRaw, injections, shadows, imports };
}

export async function analyzeMixin(source: string, mcVersion: string) {
    const { targetClass, targetRaw, injections, shadows } = parseMixinAnnotations(source);

    if (!targetClass) {
        return {
            error: "Could not resolve @Mixin target class. Check that the class is imported and @Mixin(targets = \"...\") or @Mixin(SomeClass.class) is present.",
            raw: targetRaw,
        };
    }

    const jarPath = await getMcJarPath(mcVersion);
    let members: ReturnType<typeof formatClassMembers>;
    try {
        const info = await inspectClass(jarPath, targetClass);
        members = formatClassMembers(info);
    } catch {
        const allClasses = listClasses(jarPath).map((c) => c.replace(/\.class$/, ""));
        return {
            targetClass,
            error: `Target class not found in MC ${mcVersion}: ${targetClass}`,
            suggestions: topSimilar(targetClass.split("/").pop() ?? targetClass, allClasses.map((c) => c.split("/").pop() ?? c)),
        };
    }

    const methodNames = members.methods.map((m) => m.name);
    const fieldNames  = members.fields.map((f) => f.name);

    const results = injections.map((inj) => {
        // Parse method target: "hurt(Lnet/minecraft/X;F)Z" → name + descriptor
        const colonIdx = inj.method.indexOf("(");
        const methodName  = colonIdx === -1 ? inj.method : inj.method.slice(0, colonIdx);
        const descriptor  = colonIdx === -1 ? null : inj.method.slice(colonIdx);

        const exactMatch = members.methods.find(
            (m) => m.name === methodName && (!descriptor || m.descriptor === descriptor)
        );
        const nameOnlyMatch = !exactMatch && members.methods.some((m) => m.name === methodName);

        if (exactMatch) {
            return { annotation: inj.annotationType, target: inj.method, status: "valid", mixinTarget: exactMatch.mixinTarget };
        }
        if (nameOnlyMatch && descriptor) {
            const overloads = members.methods.filter((m) => m.name === methodName).map((m) => m.mixinTarget);
            return { annotation: inj.annotationType, target: inj.method, status: "wrong_descriptor", error: `Method "${methodName}" exists but descriptor "${descriptor}" doesn't match.`, overloads };
        }
        return {
            annotation: inj.annotationType,
            target: inj.method,
            status: "not_found",
            error: `Method "${methodName}" not found in ${targetClass}`,
            suggestions: topSimilar(methodName, methodNames),
        };
    });

    const shadowResults = shadows.map((s) => {
        const inMethods = members.methods.find((m) => m.name === s);
        const inFields  = members.fields.find((f) => f.name === s);
        if (inMethods || inFields) return { name: s, status: "valid" };
        return {
            name: s,
            status: "not_found",
            error: `Shadow target "${s}" not found as method or field in ${targetClass}`,
            suggestions: topSimilar(s, [...methodNames, ...fieldNames]),
        };
    });

    const errorCount = results.filter((r) => r.status !== "valid").length + shadowResults.filter((r) => r.status !== "valid").length;

    return {
        targetClass,
        mcVersion,
        summary: { injections: injections.length, shadows: shadows.length, errors: errorCount },
        injectionResults: results,
        shadowResults,
    };
}

/**
 * Search decompiled Minecraft (or NeoForge) source for Event subclasses.
 * Returns class names + file paths for all classes that extend a known Event base.
 *
 * query: optional name filter, e.g. "Living", "Player", "Block"
 * modloader: "neoforge" searches NeoForge-specific events (needs NeoForge ingested + decompiled)
 *            "minecraft" (default) searches vanilla source for event-like classes
 */
export async function searchEvents(
    version: string,
    query?: string,
    modloader: "minecraft" | "neoforge" | "fabric" | "fabric-api" = "minecraft",
): Promise<object> {
    // ── NeoForge / Fabric: search the ingested loader mod's decompiled source ─
    const isFabric = modloader === "fabric" || modloader === "fabric-api";
    if (modloader === "neoforge" || isFabric) {
        // Fabric API may be ingested under modId "fabric-api" or "fabric"; try both
        const candidateIds = isFabric ? ["fabric-api", "fabric"] : ["neoforge"];
        let mod = null;
        for (const id of candidateIds) {
            mod = await findModByModIdLike(id);
            if (mod) break;
        }
        if (!mod) {
            throw new Error(
                `${modloader === "neoforge" ? "NeoForge" : "Fabric API"} has not been ingested. ` +
                `Run mc_versions ingest_${modloader === "neoforge" ? "neoforge" : "fabric"} first.`
            );
        }

        // Pattern differs per loader:
        //   NeoForge: classes extending Event (class-based event bus)
        //   Fabric:   static Event<T> field declarations (callback-based)
        const searchPattern = modloader === "neoforge"
            ? (query ? `class\\s+\\w*${query}\\w*\\s+extends\\s+[\\w.]*Event\\b` : `extends\\s+[\\w.]*Event\\b`)
            : (query ? `Event<.*${query}` : `public\\s+static\\s+final\\s+Event<`);

        const raw = await searchSource(searchPattern, mod.id, true, 200);

        // Fabric API is a Jar-in-Jar bundle — decompiled source may be empty.
        // Fall back to class name search when no source results are found.
        let events: Array<{ className: string; file: string; line: number }>;
        if (raw.length === 0 && isFabric) {
            const { listClasses: listJarClasses } = await import("../jar.js");
            const allClasses = listJarClasses(mod.jarPath)
                .map((c) => c.replace(/\.class$/, "").replace(/\//g, "."))
                .filter((c) => !c.includes("$")); // hide inner classes
            const q = query?.toLowerCase();
            const matched = q
                ? allClasses.filter((c) => c.toLowerCase().includes(q) && c.toLowerCase().includes("event"))
                : allClasses.filter((c) => c.toLowerCase().includes("event"));
            events = matched.map((c) => ({ className: c, file: c.replace(/\./g, "/") + ".class", line: 0 }));
        } else {
            const seen = new Set<string>();
            events = [];
            for (const r of raw) {
                if (!seen.has(r.file)) {
                    seen.add(r.file);
                    const parts = r.file.replace(/\.java$/, "").split(/[\\/]/);
                    events.push({ className: parts.join("."), file: r.file, line: r.line });
                }
            }
        }

        const note = modloader === "neoforge"
            ? "extends net.neoforged.bus.api.Event"
            : "public static final Event<T> (Fabric callback pattern)";
        return {
            version,
            modloader,
            modDbId: mod.id,
            modVersion: mod.version,
            query: query ?? "(all events)",
            count: events.length,
            note,
            events,
        };
    }

    // ── Vanilla Minecraft: search decompiled MC source ────────────────────────
    const outDir = mcPaths.decompiled(version);
    const status = await isDecompileDone(outDir);
    if (status !== "done") {
        throw new Error(
            `MC ${version} source not decompiled. Run decompile_minecraft_version first.`
        );
    }

    const results = await searchMcCode(
        version,
        query
            ? `class ${query}[\\w]* extends [\\w.]*Event`
            : `extends [\\w.]*Event\\b`,
        "content",
        true,
        200,
    );

    const seen = new Set<string>();
    const events: Array<{ className: string; file: string; line: number }> = [];
    for (const r of results) {
        if (!seen.has(r.file)) {
            seen.add(r.file);
            const parts = r.file.replace(/\.java$/, "").split("/");
            events.push({ className: parts.join("."), file: r.file, line: r.line });
        }
    }

    return {
        version,
        modloader,
        query: query ?? "(all events)",
        count: events.length,
        note: "extends net.minecraft.*Event",
        events,
    };
}
