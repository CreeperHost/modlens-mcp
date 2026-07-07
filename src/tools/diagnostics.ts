/**
 * Diagnostics tools for modpack developers.
 *
 * - analyzeCrashLog: rank suspect mods from a NeoForge/Fabric/Forge crash log
 *   by cross-referencing stack frames with the ModClass index and bounded
 *   fallback signals from modern crash report sections.
 * - findMissingDeps: find declared dependencies not satisfied by ingested mods.
 */

import { findModClassesByClassNames, listAllMods } from "../repositories/mod.js";
import { searchMods, getModsBatch, type FtbMod, type FtbModVersion } from "../modpacks-ch.js";
import { downloadModAction } from "./modpacks-ch.js";
import { reindexClasses } from "./ingest.js";
import { translateSymbol, type MappingNs } from "../mappings.js";

// Loader-level pseudo-deps that are never in the mod DB
const SKIP_DEP_IDS = new Set([
    "minecraft", "neoforge", "forge", "fabric-api", "fabricloader",
    "quilt_loader", "java", "modlauncher", "fml_loader", "mixin",
    "spongepowered", "architectury", "fabric", "knot", "bootstrap",
    "server", "client", "loader", "modlauncher", "bootstraplauncher",
    "cpw.mods.modlauncher", "cpw.mods.bootstraplauncher", "lowcodefml",
    "dev", "neoforged", "cpw",
]);

const MAX_SUSPECTS = 10;
const MAX_POPULATE_ATTEMPTS = 3;
const OBFUSCATED_WORD_STOPLIST = new Set(["a", "an", "as", "at", "be", "by", "can", "cast", "for", "if", "in", "is", "it", "new", "not", "of", "on", "or", "the", "to"]);

type FrameSource = "module" | "plain";

type ParsedFrame = {
    className: string;
    method: string;
    raw: string;
    source: FrameSource;
    modId?: string;
    jar?: string;
    location?: string;
    line?: number;
    mappedClass?: string;
    mappedMethod?: string;
    mappedNamespace?: MappingNs;
    mappedOwner?: "minecraft";
    mappingNote?: string;
};

type Candidate = {
    modId: string;
    display?: string;
    dbId?: number | null;
    frameCount: number;
    frames: string[];
    jars: string[];
    source: string;
    reasons: string[];
};

type CrashFacts = {
    description?: string;
    exception?: string;
    causedBy: string[];
    modLoadingIssues: Array<{ modId: string; modFile?: string; failure?: string; exception?: string }>;
    missingDependencies: Array<{ requiredBy?: string; depModId: string; version?: string }>;
    tickContext: Record<string, string>;
    mappedException?: string;
    mappedCausedBy?: string[];
    mappedExceptionClasses?: Array<{ raw: string; mappedClass: string; namespace: MappingNs }>;
    minecraftVersion?: string;
    loader?: string;
};

type PopulateAttempt = {
    modId: string;
    terms: string[];
    status: string;
    remoteId?: number | string;
    fileId?: number;
    message?: string;
};

export async function analyzeCrashLog(logText: string): Promise<object> {
    const frames = parseFrames(logText);
    const facts = parseCrashFacts(logText);
    await enrichMappedCrashFacts(facts);
    await enrichMappedFrames(frames, facts);
    const rawFrames = frames.map((f) => f.className);
    const uniqueClasses = [...new Set(rawFrames)];
    const modsInLogSection = parseModsInLogSection(logText);

    let lookup = await lookupModClasses(uniqueClasses);
    let rows = lookup.rows;
    let candidates = buildCandidates(frames, rows, facts, modsInLogSection);
    const population = lookup.available
        ? await populateMissingMods(candidates, frames, facts)
        : { attempted: 0, attempts: [], skipped: "mod class database unavailable" };

    if (population.attempts.some((a) => a.status === "ingested" || a.status === "replaced" || a.status === "already_ingested")) {
        lookup = await lookupModClasses(uniqueClasses);
        rows = lookup.rows;
        candidates = buildCandidates(frames, rows, facts, modsInLogSection);
    }

    const recognized = frames.filter((f) => rows.some((r) => r.className === f.className)).length;
    const mappedVanilla = frames.filter((f) => f.mappedOwner === "minecraft").length;
    const suspects = candidates.slice(0, MAX_SUSPECTS).map((s) => ({
        modId: s.modId,
        display: s.display ?? s.modId,
        dbId: s.dbId ?? null,
        frameCount: s.frameCount,
        frames: s.frames.slice(0, 5),
        jars: s.jars.slice(0, 3),
        source: s.source,
        reasons: s.reasons.slice(0, 4),
    }));

    const unrecognized = rawFrames.length - recognized - mappedVanilla;
    const coverageWarning =
        rawFrames.length >= 5 && unrecognized / rawFrames.length > 0.5
            ? `${unrecognized}/${rawFrames.length} stack frames could not be matched to ingested mods. Fallback crash signals were used; ingest the missing jars to improve coverage.`
            : undefined;

    return {
        suspects,
        fallbackSuspects: suspects.filter((s) => s.dbId === null),
        crashFacts: facts,
        frames: frames.slice(0, 50),
        mappedFrames: frames.filter((f) => f.mappedOwner).slice(0, 50),
        modsInLogSection,
        totalFrames: rawFrames.length,
        recognizedFrames: recognized,
        unrecognizedFrames: unrecognized,
        population,
        ...(coverageWarning ? { coverageWarning } : {}),
    };
}

async function lookupModClasses(classNames: string[]): Promise<{ rows: Awaited<ReturnType<typeof findModClassesByClassNames>>; available: boolean }> {
    try {
        return { rows: await findModClassesByClassNames(classNames), available: true };
    } catch {
        return { rows: [], available: false };
    }
}

function parseFrames(logText: string): ParsedFrame[] {
    const frames: ParsedFrame[] = [];
    const modernRe = /^\s*at\s+(?:(?:TRANSFORMER|MOD|KNOT|MC-BOOTSTRAP|BOOTSTRAP)\/)?([^@\s/]+)@[^/\s]+\/([A-Za-z_$][\w$]*(?:[.$/][A-Za-z_$][\w$]*)*)\.([A-Za-z_$<][\w$<>[\]]*)\(([^)]*)\)(.*)$/;
    const plainRe = /^\s*at\s+([A-Za-z_$][\w$]*(?:[.$/][A-Za-z_$][\w$]*)*)\.([A-Za-z_$<][\w$<>[\]]*)\(([^)]*)\)(.*)$/;

    for (const line of logText.split(/\r?\n/)) {
        let m = line.match(modernRe);
        if (m) {
            frames.push({
                className: normalizeClassName(m[2]),
                method: m[3],
                raw: line.trim(),
                source: "module",
                modId: cleanModId(m[1]),
                location: m[4],
                line: parseSourceLine(m[4]),
                jar: extractJar(line),
            });
            continue;
        }
        m = line.match(plainRe);
        if (m) {
            frames.push({
                className: normalizeClassName(m[1]),
                method: m[2],
                raw: line.trim(),
                source: "plain",
                location: m[3],
                line: parseSourceLine(m[3]),
                modId: undefined,
                jar: extractJar(line),
            });
        }
    }
    return frames;
}

async function enrichMappedFrames(frames: ParsedFrame[], facts: CrashFacts): Promise<void> {
    if (!facts.minecraftVersion) return;
    const classCache = new Map<string, Awaited<ReturnType<typeof translateSymbol>>>();
    const classNamespaceCache = new Map<string, MappingNs>();
    const methodCache = new Map<string, Awaited<ReturnType<typeof translateSymbol>>>();

    for (const frame of frames) {
        if (!isObfuscatedVanillaFrame(frame)) continue;
        let mapped = classCache.get(frame.className);
        let mappedNamespace = classNamespaceCache.get(frame.className) ?? "mcp";
        if (!mapped) {
            mapped = await translateSymbol(frame.className, "official", "mcp", facts.minecraftVersion);
            if (!mapped.found) {
                mapped = await translateSymbol(frame.className, "official", "srg", facts.minecraftVersion);
                mappedNamespace = "srg";
            }
            classCache.set(frame.className, mapped);
            classNamespaceCache.set(frame.className, mappedNamespace);
        }
        if (!mapped.found || !mapped.target) continue;

        frame.mappedClass = normalizeClassName(mapped.target);
        frame.mappedNamespace = mappedNamespace;
        frame.mappedOwner = "minecraft";
        if (mapped.note) frame.mappingNote = mapped.note;

        const methodKey = `${frame.className}/${frame.method}`;
        let mappedMethod = methodCache.get(methodKey);
        if (!mappedMethod) {
            mappedMethod = await translateSymbol(methodKey, "official", "mcp", facts.minecraftVersion);
            if (!mappedMethod.found) mappedMethod = await translateSymbol(methodKey, "official", "srg", facts.minecraftVersion);
            methodCache.set(methodKey, mappedMethod);
        }
        if (mappedMethod.found && mappedMethod.target) frame.mappedMethod = mappedMethod.target.split("/").pop();
    }
}

function isObfuscatedVanillaFrame(frame: ParsedFrame): boolean {
    if (frame.source !== "plain" || frame.jar || frame.modId) return false;
    if (frame.className.includes("/") || frame.className.includes(".")) return false;
    if (!/^[a-z]{1,4}$/i.test(frame.className)) return false;
    return !frame.location || /^SourceFile(?::\d+)?$/i.test(frame.location);
}

async function enrichMappedCrashFacts(facts: CrashFacts): Promise<void> {
    if (!facts.minecraftVersion) return;
    const mappedExceptionClasses: Array<{ raw: string; mappedClass: string; namespace: MappingNs }> = [];
    const classCache = new Map<string, { mappedClass: string; namespace: MappingNs } | null>();

    const mapText = async (text: string): Promise<string> => {
        let mappedText = text;
        const names = [...new Set([...text.matchAll(/\b[a-z]{1,4}\b/g)].map((m) => m[0]).filter((name) => !OBFUSCATED_WORD_STOPLIST.has(name.toLowerCase())))];
        for (const name of names) {
            let mapped = classCache.get(name);
            if (mapped === undefined) {
                let result = await translateSymbol(name, "official", "mcp", facts.minecraftVersion!);
                let namespace: MappingNs = "mcp";
                if (!result.found) {
                    result = await translateSymbol(name, "official", "srg", facts.minecraftVersion!);
                    namespace = "srg";
                }
                mapped = result.found && result.target && normalizeClassName(result.target).startsWith("net/minecraft/")
                    ? { mappedClass: normalizeClassName(result.target), namespace }
                    : null;
                classCache.set(name, mapped);
            }
            if (!mapped) continue;
            if (!mappedExceptionClasses.some((entry) => entry.raw === name)) mappedExceptionClasses.push({ raw: name, mappedClass: mapped.mappedClass, namespace: mapped.namespace });
            mappedText = mappedText.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), simpleClassName(mapped.mappedClass));
        }
        return mappedText;
    };

    if (facts.exception) facts.mappedException = await mapText(facts.exception);
    if (facts.causedBy.length > 0) facts.mappedCausedBy = await Promise.all(facts.causedBy.map(mapText));
    if (mappedExceptionClasses.length > 0) facts.mappedExceptionClasses = mappedExceptionClasses;
}

function parseCrashFacts(logText: string): CrashFacts {
    const facts: CrashFacts = { causedBy: [], modLoadingIssues: [], missingDependencies: [], tickContext: {} };
    facts.description = logText.match(/Description:\s*(.+)/)?.[1]?.trim();
    facts.exception = logText.match(/^\s*((?:[\w.$]+\.)?(?:\w+Exception|\w+Error)(?::\s*.+)?)/m)?.[1]?.trim();
    facts.minecraftVersion = logText.match(/Minecraft Version:\s*([^\r\n]+)/i)?.[1]?.trim()
        ?? logText.match(/-- System Details --[\s\S]*?Details:\s*Minecraft Version:\s*([^\r\n]+)/i)?.[1]?.trim();
    const loaderText = logText.match(/(?:Forge|NeoForge|Fabric Loader) Version:\s*([^\r\n]+)/i)?.[0]?.toLowerCase()
        ?? logText.match(/ModLauncher:\s*([^\r\n]+)/i)?.[0]?.toLowerCase();
    if (loaderText?.includes("neoforge")) facts.loader = "neoforge";
    else if (loaderText?.includes("fabric")) facts.loader = "fabric";
    else if (loaderText?.includes("forge")) facts.loader = "forge";

    for (const m of logText.matchAll(/^\s*Caused by:\s*(.+)$/gm)) facts.causedBy.push(m[1].trim());

    const issueRe = /-- Mod loading issue for:\s*([^\s-]+)\s*--([\s\S]*?)(?=\n-- |\n\n|$)/g;
    for (const m of logText.matchAll(issueRe)) {
        const body = m[2];
        const issue = {
            modId: cleanModId(m[1]),
            modFile: body.match(/Mod file:\s*([^\r\n]+)/i)?.[1]?.trim(),
            failure: body.match(/Failure message:\s*([^\r\n]+)/i)?.[1]?.trim(),
            exception: body.match(/Exception message:\s*([^\r\n]+)/i)?.[1]?.trim(),
        };
        facts.modLoadingIssues.push(issue);
        parseMissingDependency(issue.failure ?? "", issue.modId, facts);
        parseMissingDependency(issue.exception ?? "", issue.modId, facts);
    }

    for (const line of logText.split(/\r?\n/)) parseMissingDependency(line, undefined, facts);

    for (const sectionName of ["Block entity being ticked", "Entity being ticked", "Affected level", "Block being ticked"]) {
        const section = logText.match(new RegExp(`-- ${escapeRegExp(sectionName)} --\\n([\\s\\S]*?)(?:\\n--|$)`));
        if (!section) continue;
        for (const line of section[1].split(/\r?\n/)) {
            const m = line.match(/^\s*([^:]+):\s*(.+)$/);
            if (m) facts.tickContext[m[1].trim()] = m[2].trim();
        }
    }

    return facts;
}

function parseMissingDependency(text: string, requiredBy: string | undefined, facts: CrashFacts) {
    const lower = text.toLowerCase();
    const notInstalled = text.match(/currently,\s*([a-z0-9_.-]+)\s+is not installed/i)?.[1];
    const requires = text.match(/requires\s+([a-z0-9_.-]+)\s+([^,.;]+)?/i);
    const depModId = cleanModId(notInstalled ?? requires?.[1] ?? "");
    if (!depModId || SKIP_DEP_IDS.has(depModId)) return;
    if (!lower.includes("requires") && !lower.includes("not installed") && !lower.includes("missing")) return;
    if (facts.missingDependencies.some((d) => d.depModId === depModId && d.requiredBy === requiredBy)) return;
    facts.missingDependencies.push({ requiredBy, depModId, version: requires?.[2]?.trim() });
}

function parseModsInLogSection(logText: string): string[] {
    const mods = new Set<string>();
    const sections = logText.matchAll(/(?:-- Mod List --|Mod List:|Fabric Mods:)\s*\n([\s\S]*?)(?:\n-- |\n\n|$)/g);
    for (const section of sections) {
        for (const line of section[1].split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.includes("|")) {
                const parts = trimmed.split("|").map((p) => p.trim()).filter(Boolean);
                if (parts.length >= 3) { addModId(mods, parts[2]); continue; }
            }
            let m = trimmed.match(/^([a-z0-9_.-]+)\|/i);
            if (m) { addModId(mods, m[1]); continue; }
            m = trimmed.match(/^\|\s*[A-Z\s]+\|\s*([a-z0-9_.-]+)\s*\|/i);
            if (m) { addModId(mods, m[1]); continue; }
            m = trimmed.match(/^\|[^|]*\.jar\s*\|[^|]*\|\s*([a-z0-9_.-]+)\s*\|/i);
            if (m) { addModId(mods, m[1]); continue; }
            m = trimmed.match(/^([a-z0-9_.-]+):\s+.+\s+[\w.-]+$/i);
            if (m) addModId(mods, m[1]);
        }
    }
    return [...mods];
}

function buildCandidates(
    frames: ParsedFrame[],
    rows: Awaited<ReturnType<typeof findModClassesByClassNames>>,
    facts: CrashFacts,
    modsInLogSection: string[],
): Candidate[] {
    const byClass = new Map(rows.map((r) => [r.className, r]));
    const candidates = new Map<string, Candidate>();

    const add = (modId: string, reason: string, frame?: ParsedFrame, display?: string, dbId?: number | null, source = "fallback") => {
        modId = cleanModId(modId);
        if (!modId || SKIP_DEP_IDS.has(modId)) return;
        const c = candidates.get(modId) ?? {
            modId,
            display,
            dbId: dbId ?? null,
            frameCount: 0,
            frames: [],
            jars: [],
            source,
            reasons: [],
        };
        if (display && (!c.display || c.display === c.modId)) c.display = display;
        if (dbId) c.dbId = dbId;
        if (c.source !== "indexed" && source === "indexed") c.source = "indexed";
        if (!c.reasons.includes(reason)) c.reasons.push(reason);
        if (frame) {
            c.frameCount++;
            if (!c.frames.includes(frame.className)) c.frames.push(frame.className);
            if (frame.jar && !c.jars.includes(frame.jar)) c.jars.push(frame.jar);
        }
        candidates.set(modId, c);
    };

    for (const frame of frames) {
        if (frame.mappedOwner === "minecraft") continue;
        const row = byClass.get(frame.className);
        if (row) {
            add(row.mod.modId, "class matched ingested mod", frame, row.mod.displayName, row.modId, "indexed");
            continue;
        }
        if (frame.modId) add(frame.modId, "module stack frame named this mod", frame, undefined, null, "stack");
        const jarModId = modIdFromJar(frame.jar);
        if (jarModId) add(jarModId, "stack frame came from this jar", frame, undefined, null, "jar");
        if (!frame.modId && !jarModId) {
            const packageModId = modIdFromClass(frame.className);
            if (packageModId) add(packageModId, "class package points at this mod", frame, undefined, null, "package");
        }
    }

    for (const issue of facts.modLoadingIssues) {
        add(issue.modId, "mod loading issue section names this mod", undefined, undefined, null, "mod_loading_issue");
        const jarModId = modIdFromJar(issue.modFile);
        if (jarModId) add(jarModId, "mod loading issue names this jar", undefined, undefined, null, "jar");
    }

    for (const dep of facts.missingDependencies) {
        add(dep.depModId, "required dependency is missing", undefined, undefined, null, "dependency");
        if (dep.requiredBy) add(dep.requiredBy, "mod has a failed dependency", undefined, undefined, null, "dependency");
    }

    for (const value of Object.values(facts.tickContext)) {
        const namespace = value.match(/\b([a-z0-9_.-]+):[a-z0-9_./-]+/i)?.[1];
        if (namespace) add(namespace, "ticking context uses this namespace", undefined, undefined, null, "tick_context");
    }

    const inPack = new Set(modsInLogSection.map(cleanModId));
    return [...candidates.values()]
        .filter((c) => c.dbId || c.frameCount > 0 || inPack.has(c.modId) || c.source !== "package")
        .sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || b.frameCount - a.frameCount || a.modId.localeCompare(b.modId));
}

async function populateMissingMods(candidates: Candidate[], frames: ParsedFrame[], facts: CrashFacts): Promise<{ attempted: number; attempts: PopulateAttempt[] }> {
    const attempts: PopulateAttempt[] = [];
    const unresolved = candidates.filter((c) => !c.dbId && ["stack", "jar", "mod_loading_issue", "dependency"].includes(c.source)).slice(0, MAX_POPULATE_ATTEMPTS);
    for (const candidate of unresolved) {
        const terms = [...new Set([candidate.modId, candidate.display, ...candidate.jars.map(stripJarVersion)].filter((v): v is string => !!v))];
        const attempt: PopulateAttempt = { modId: candidate.modId, terms, status: "not_found" };
        attempts.push(attempt);
        try {
            const remote = await findRemoteMod(terms, candidate, facts);
            if (!remote) continue;
            const version = pickRemoteVersion(remote, candidate, facts);
            attempt.remoteId = remote.id;
            if (version) attempt.fileId = version.id;
            const result = await downloadModAction(remote.id, {
                mcVersion: version ? undefined : facts.minecraftVersion,
                loader: version ? undefined : facts.loader,
                fileId: version?.id,
            });
            attempt.status = result.status;
            attempt.message = result.message ?? result.name;
            if (result.modId && ["ingested", "replaced", "already_ingested"].includes(result.status)) {
                const indexed = await reindexClasses(result.modId).catch((err) => ({ indexed: 0, failed: 1, skipped: 0, error: err instanceof Error ? err.message : String(err) }));
                attempt.message = (attempt.message ? attempt.message + "; " : "") + "indexed " + indexed.indexed + " classes";
            }
        } catch (err) {
            attempt.status = "failed";
            attempt.message = err instanceof Error ? err.message : String(err);
        }
    }
    return { attempted: attempts.length, attempts };
}

async function findRemoteMod(terms: string[], candidate: Candidate, facts: CrashFacts): Promise<FtbMod | null> {
    for (const term of terms) {
        const found = await searchMods(term, 8);
        const ids = found?.mods ?? [];
        if (ids.length === 0) continue;
        const mods = await getModsBatch(ids.slice(0, 8));
        const wanted = normalized(term);
        const byName = mods
            .map((m) => ({ mod: m, score: remoteScore(m, wanted, candidate, facts) }))
            .sort((a, b) => a.score - b.score || b.mod.installs - a.mod.installs);
        if (byName[0] && byName[0].score < 6) return byName[0].mod;
    }
    return null;
}

function remoteScore(mod: FtbMod, wanted: string, candidate: Candidate, facts: CrashFacts): number {
    const name = normalized(mod.name);
    const links = (mod.links ?? []).map((l) => normalized(l.link + " " + l.name + " " + l.type)).join(" ");
    if (name === wanted) return 0;
    if (links.includes(wanted)) return 1;
    if (name.includes(wanted) || wanted.includes(name)) return 2;
    if (mod.versions?.some((v) => candidate.jars.some((j) => normalized(v.name) === normalized(j)))) return 0;
    if (facts.loader && !mod.versions?.some((v) => versionMatches(v, facts))) return 5;
    return 6;
}

function pickRemoteVersion(mod: FtbMod, candidate: Candidate, facts: CrashFacts): FtbModVersion | undefined {
    const jars = candidate.jars.map(normalized);
    const exactJar = mod.versions?.find((v) => jars.includes(normalized(v.name)));
    if (exactJar) return exactJar;
    return mod.versions?.find((v) => versionMatches(v, facts));
}

function versionMatches(version: FtbModVersion, facts: CrashFacts): boolean {
    if (facts.minecraftVersion && !version.targets.some((t) => t.type === "game" && t.version === facts.minecraftVersion)) return false;
    if (facts.loader && !version.targets.some((t) => t.type === "modloader" && t.name.toLowerCase() === facts.loader)) return false;
    return true;
}

function scoreCandidate(c: Candidate): number {
    let score = c.frameCount;
    if (c.dbId) score += 1000;
    if (c.source === "mod_loading_issue") score += 80;
    if (c.source === "dependency") score += 70;
    if (c.source === "stack") score += 60;
    if (c.source === "jar") score += 40;
    if (c.source === "tick_context") score += 20;
    if (c.source === "package") score -= 20;
    return score;
}

function parseSourceLine(location: string | undefined): number | undefined {
    const match = location?.match(/:(\d+)\)?$/);
    return match ? Number(match[1]) : undefined;
}

function extractJar(line: string): string | undefined {
    const match = line.match(/\[([^\]\r\n]*?\.jar)(?:[!%\]\s:/?].*)?\]/i);
    if (!match) return undefined;
    return basename(match[1].split(/[!%]/)[0]);
}

function modIdFromJar(jar?: string): string | undefined {
    if (!jar) return undefined;
    const base = stripJarVersion(jar);
    return cleanModId(base.replace(/[^a-z0-9_.-]+/gi, "_"));
}

function stripJarVersion(jar: string): string {
    return basename(jar).replace(/\.jar$/i, "").replace(/[-_]?\d[\w.+-]*$/i, "");
}

function modIdFromClass(className: string): string | undefined {
    const parts = className.split("/").map(cleanModId).filter(Boolean);
    if (parts.length === 0) return undefined;
    if (["net/minecraft", "com/mojang", "org/spongepowered", "cpw/mods", "java/", "javax/", "sun/", "com/sun/", "jdk/", "net/minecraft/launchwrapper", "magic/launcher"].some((p) => className.startsWith(p))) return undefined;
    if (["com", "org", "net", "io", "me", "dev"].includes(parts[0]) && parts[1]) return parts[1];
    if (["mcjty"].includes(parts[0]) && parts[1]) return parts[1];
    return parts[0];
}

function normalizeClassName(value: string): string {
    return value.replace(/\./g, "/");
}

function simpleClassName(value: string): string {
    return value.replace(/[\\/]/g, ".").split(".").pop() ?? value;
}

function cleanModId(value: string | undefined): string {
    return (value ?? "").trim().toLowerCase().replace(/^mods\//, "").replace(/\.jar$/i, "").replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

function addModId(set: Set<string>, value: string) {
    const modId = cleanModId(value);
    if (modId && !SKIP_DEP_IDS.has(modId)) set.add(modId);
}

function basename(path: string): string {
    return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function normalized(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function findMissingDeps(mcVersion?: string, loader?: string): Promise<object> {
    const allMods = await listAllMods();

    // Full ingested modId set (deps may cross mcVersion boundaries)
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