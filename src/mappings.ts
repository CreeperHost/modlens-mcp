/**
 * Mapping utilities for Minecraft: download, parse, and translate symbols
 * across official / intermediary / yarn / mojmap namespaces.
 *
 * Also supports Parchment parameter names + javadocs layered on top of mojmap.
 *
 * Data sources:
 *   - Intermediary: https://maven.fabricmc.net/net/fabricmc/intermediary/{v}/intermediary-{v}-v2.jar
 *   - Yarn:         https://maven.fabricmc.net/net/fabricmc/yarn/{yarnVer}/yarn-{yarnVer}-v2.jar
 *   - Mojmap:       Mojang's client_mappings ProGuard file (inverted to official→named)
 *   - Parchment:    https://maven.parchmentmc.org/org/parchmentmc/data/parchment-{v}/{build}/parchment-{v}-{build}-checked.zip
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import AdmZip from "adm-zip";
import { CACHE_ROOT, exists, ensureDir } from "./cache.js";
import { spawn } from "child_process";

// ── Cache dirs ────────────────────────────────────────────────────────────────
export const MAPPINGS_DIR = join(CACHE_ROOT, "mappings");
export const PARCHMENT_DIR = join(CACHE_ROOT, "parchment");
const TOOLS_DIR = join(CACHE_ROOT, "tools");

const TINY_REMAPPER_VERSION = "0.10.3";
export const TINY_REMAPPER_PATH = join(TOOLS_DIR, "tiny-remapper.jar");
const TINY_REMAPPER_URL = `https://maven.fabricmc.net/net/fabricmc/tiny-remapper/${TINY_REMAPPER_VERSION}/tiny-remapper-${TINY_REMAPPER_VERSION}-fat.jar`;

const SPECIAL_SOURCE_VERSION = "1.11.4";
export const SPECIAL_SOURCE_PATH = join(TOOLS_DIR, "SpecialSource.jar");
const SPECIAL_SOURCE_URL = `https://maven.minecraftforge.net/net/md-5/SpecialSource/${SPECIAL_SOURCE_VERSION}/SpecialSource-${SPECIAL_SOURCE_VERSION}-shaded.jar`;

// ── Types ─────────────────────────────────────────────────────────────────────
export type MappingNs = "official" | "intermediary" | "yarn" | "mojmap" | "srg" | "mcp";

interface TinyV2Index {
    ns: [string, string];
    classes: Map<string, string>;
    fields: Map<string, Map<string, string>>;   // className → (fromField:desc → toField)
    methods: Map<string, Map<string, string>>;   // className → (fromMethod+desc → toMethod)
}

export interface TranslateResult {
    found: boolean;
    source: string;
    target?: string;
    type: "class" | "method" | "field" | "unknown";
    containingClass?: string;
    note?: string;
}

// ── Parchment types ───────────────────────────────────────────────────────────
export interface ParchmentData {
    classes: Map<string, ParchmentClass>;
}
export interface ParchmentClass {
    name: string;
    javadoc?: string[];
    fields: Map<string, ParchmentField>;        // fieldName:descriptor → ParchmentField
    methods: Map<string, ParchmentMethod>;       // methodName+descriptor → ParchmentMethod
}
export interface ParchmentField  { name: string; javadoc?: string[]; }
export interface ParchmentMethod { name: string; descriptor: string; javadoc?: string[]; parameters: ParchmentParam[]; }
export interface ParchmentParam  { index: number; name: string; javadoc?: string; }

// ── In-memory caches ──────────────────────────────────────────────────────────
const tinyIndexCache = new Map<string, TinyV2Index | null>();
const mojmapCache    = new Map<string, Map<string, string> | null>(); // version → (official→named)
const parchmentCache = new Map<string, ParchmentData | null>();

// ── Helpers ───────────────────────────────────────────────────────────────────
async function downloadToFile(url: string, dest: string): Promise<void> {
    await ensureDir(dest);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed ${url}: ${res.status}`);
    const buf = await res.arrayBuffer();
    await writeFile(dest, Buffer.from(buf));
}

async function extractTinyFromJar(jarPath: string, entry: string, dest: string): Promise<void> {
    const zip = new AdmZip(jarPath);
    const e = zip.getEntry(entry);
    if (!e) throw new Error(`Entry '${entry}' not found in ${jarPath}`);
    await ensureDir(dest);
    await writeFile(dest, e.getData());
}

// ── Tiny V2 parser ────────────────────────────────────────────────────────────
export function parseTinyV2(content: string): TinyV2Index {
    const lines = content.split("\n");
    const header = lines[0].split("\t");
    const ns0 = header[3] ?? "official";
    const ns1 = header[4] ?? "intermediary";

    const classes = new Map<string, string>();
    const fields  = new Map<string, Map<string, string>>();
    const methods = new Map<string, Map<string, string>>();

    let curClass = "";
    let curFields:  Map<string, string> | null = null;
    let curMethods: Map<string, string> | null = null;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.startsWith("#")) continue;

        const depth = (line.match(/^\t*/)?.[0].length) ?? 0;
        const parts = line.trimStart().split("\t");

        if (depth === 0 && parts[0] === "c") {
            curClass = parts[1];
            const toClass = parts[2] ?? parts[1];
            classes.set(curClass, toClass);
            curFields  = new Map(); fields.set(curClass, curFields);
            curMethods = new Map(); methods.set(curClass, curMethods);
        } else if (depth === 1 && parts[0] === "f" && curFields) {
            const [, desc, fromName, toName] = parts;
            curFields.set(`${fromName}:${desc}`, toName ?? fromName);
        } else if (depth === 1 && parts[0] === "m" && curMethods) {
            const [, desc, fromName, toName] = parts;
            curMethods.set(`${fromName}${desc}`, toName ?? fromName);
        }
    }
    return { ns: [ns0, ns1], classes, fields, methods };
}

// ── ProGuard parser (named → official, inverted to official → named) ──────────
function parseProGuardClasses(content: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of content.split("\n")) {
        if (line.startsWith("#") || line.startsWith(" ") || line.startsWith("\t") || !line.trim()) continue;
        const m = line.match(/^(.+) -> (.+):$/);
        if (m) {
            const named = m[1].trim().replace(/\./g, "/");
            const obf   = m[2].trim().replace(/\./g, "/");
            map.set(obf, named);   // official(obf) → named
        }
    }
    return map;
}

// ── Fabric Meta ───────────────────────────────────────────────────────────────
async function resolveYarnVersion(mcVersion: string): Promise<string | null> {
    try {
        const res = await fetch(`https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(mcVersion)}`);
        if (!res.ok) return null;
        const versions = await res.json() as Array<{ version: string; stable: boolean }>;
        const stable = versions.filter(v => v.stable);
        const list = stable.length > 0 ? stable : versions;
        if (list.length === 0) return null;
        list.sort((a, b) => {
            const ba = parseInt(a.version.split("+build.")[1] ?? "0");
            const bb = parseInt(b.version.split("+build.")[1] ?? "0");
            return bb - ba;
        });
        return list[0].version;
    } catch { return null; }
}

// ── Mapping index loaders ─────────────────────────────────────────────────────
async function getIntermediaryIndex(version: string): Promise<TinyV2Index | null> {
    const key = `intermediary-${version}`;
    if (tinyIndexCache.has(key)) return tinyIndexCache.get(key) ?? null;

    const tinyPath = join(MAPPINGS_DIR, `intermediary-${version}.tiny`);
    if (!(await exists(tinyPath))) {
        const jarPath = join(MAPPINGS_DIR, `intermediary-${version}.jar`);
        const url = `https://maven.fabricmc.net/net/fabricmc/intermediary/${encodeURIComponent(version)}/intermediary-${encodeURIComponent(version)}-v2.jar`;
        try {
            await downloadToFile(url, jarPath);
            await extractTinyFromJar(jarPath, "mappings/mappings.tiny", tinyPath);
        } catch { tinyIndexCache.set(key, null); return null; }
    }
    try {
        const index = parseTinyV2(await readFile(tinyPath, "utf8"));
        tinyIndexCache.set(key, index);
        return index;
    } catch { tinyIndexCache.set(key, null); return null; }
}

async function getYarnIndex(version: string): Promise<TinyV2Index | null> {
    const key = `yarn-${version}`;
    if (tinyIndexCache.has(key)) return tinyIndexCache.get(key) ?? null;

    const tinyPath = join(MAPPINGS_DIR, `yarn-${version}.tiny`);
    if (!(await exists(tinyPath))) {
        const yarnVersion = await resolveYarnVersion(version);
        if (!yarnVersion) { tinyIndexCache.set(key, null); return null; }
        const jarPath = join(MAPPINGS_DIR, `yarn-${version}.jar`);
        const url = `https://maven.fabricmc.net/net/fabricmc/yarn/${encodeURIComponent(yarnVersion)}/yarn-${encodeURIComponent(yarnVersion)}-v2.jar`;
        try {
            await downloadToFile(url, jarPath);
            await extractTinyFromJar(jarPath, "mappings/mappings.tiny", tinyPath);
        } catch { tinyIndexCache.set(key, null); return null; }
    }
    try {
        const index = parseTinyV2(await readFile(tinyPath, "utf8"));
        tinyIndexCache.set(key, index);
        return index;
    } catch { tinyIndexCache.set(key, null); return null; }
}

async function getMojmapClassMap(version: string): Promise<Map<string, string> | null> {
    if (mojmapCache.has(version)) return mojmapCache.get(version) ?? null;

    const cachePath = join(MAPPINGS_DIR, `mojmap-classes-${version}.json`);
    if (!(await exists(cachePath))) {
        try {
            const manifestRes = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
            if (!manifestRes.ok) { mojmapCache.set(version, null); return null; }
            const manifest = await manifestRes.json() as { versions: Array<{ id: string; url: string }> };
            const entry = manifest.versions.find(v => v.id === version);
            if (!entry) { mojmapCache.set(version, null); return null; }

            const metaRes = await fetch(entry.url);
            if (!metaRes.ok) { mojmapCache.set(version, null); return null; }
            const meta = await metaRes.json() as { downloads?: { client_mappings?: { url: string } } };
            const mappingsUrl = meta.downloads?.client_mappings?.url;
            if (!mappingsUrl) { mojmapCache.set(version, null); return null; }

            const pgPath = join(MAPPINGS_DIR, `proguard-${version}.txt`);
            await downloadToFile(mappingsUrl, pgPath);
            const classMap = parseProGuardClasses(await readFile(pgPath, "utf8"));
            await ensureDir(cachePath);
            await writeFile(cachePath, JSON.stringify(Object.fromEntries(classMap)));
        } catch { mojmapCache.set(version, null); return null; }
    }
    try {
        const raw = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, string>;
        const map = new Map(Object.entries(raw));
        mojmapCache.set(version, map);
        return map;
    } catch { mojmapCache.set(version, null); return null; }
}

// ── Index lookup helper ───────────────────────────────────────────────────────
export function lookupInIndex(idx: TinyV2Index, symbol: string, reverse: boolean): TranslateResult {
    const notFound: TranslateResult = { found: false, source: symbol, type: "unknown" };

    // Class lookup
    if (!reverse) {
        const target = idx.classes.get(symbol);
        if (target) return { found: true, source: symbol, target, type: "class" };
    } else {
        for (const [from, to] of idx.classes) {
            if (to === symbol) return { found: true, source: symbol, target: from, type: "class" };
        }
    }

    // Method lookup
    for (const [className, methodMap] of idx.methods) {
        if (!reverse) {
            for (const [key, toName] of methodMap) {
                if (key === symbol || key.startsWith(symbol + "(") || key.startsWith(symbol + "()")) {
                    const toClass = idx.classes.get(className) ?? className;
                    return { found: true, source: symbol, target: toName, type: "method", containingClass: toClass };
                }
            }
        } else {
            for (const [fromKey, toName] of methodMap) {
                if (toName === symbol) {
                    return { found: true, source: symbol, target: fromKey.split("(")[0], type: "method", containingClass: className };
                }
            }
        }
    }

    // Field lookup
    for (const [className, fieldMap] of idx.fields) {
        if (!reverse) {
            for (const [key, toName] of fieldMap) {
                const fieldName = key.split(":")[0];
                if (fieldName === symbol) {
                    const toClass = idx.classes.get(className) ?? className;
                    return { found: true, source: symbol, target: toName, type: "field", containingClass: toClass };
                }
            }
        } else {
            for (const [fromKey, toName] of fieldMap) {
                if (toName === symbol) {
                    return { found: true, source: symbol, target: fromKey.split(":")[0], type: "field", containingClass: className };
                }
            }
        }
    }

    return notFound;
}

// ── SRG/MCP mappings (legacy Forge 1.7.10–1.12.2) ────────────────────────────

/**
 * Known stable MCP channels per MC version.
 * Format: "stable_{num}-{mcVersion}" or "snapshot_{date}-{mcVersion}"
 */
const MCP_CHANNELS: Record<string, string> = {
    "1.7.10": "stable_12-1.7.10",
    "1.8":    "stable_18-1.8",
    "1.8.8":  "stable_20-1.8.8",
    "1.8.9":  "stable_22-1.8.9",
    "1.9":    "stable_24-1.9",
    "1.9.4":  "stable_26-1.9.4",
    "1.10.2": "stable_29-1.10.2",
    "1.11":   "stable_31-1.11",
    "1.11.2": "stable_32-1.11.2",
    "1.12":   "stable_39-1.12",
    "1.12.1": "stable_39-1.12",
    "1.12.2": "stable_39-1.12",
};

interface SrgIndex {
    classes: Map<string, string>;   // notch → srg class name
    methods: Map<string, string>;   // "notch_class/notch_method notch_desc" → "srg_class/srg_method"
    fields: Map<string, string>;    // "notch_class/notch_field" → "srg_class/srg_field"
}

interface McpNames {
    methods: Map<string, string>;   // func_12345_a → humanReadableName
    fields: Map<string, string>;    // field_12345_b → humanReadableName
}

const srgCache = new Map<string, SrgIndex | null>();
const mcpCache = new Map<string, McpNames | null>();

function parseSrg(content: string): SrgIndex {
    const classes = new Map<string, string>();
    const methods = new Map<string, string>();
    const fields = new Map<string, string>();
    for (const line of content.split("\n")) {
        const parts = line.trim().split(" ");
        if (parts[0] === "CL:") {
            classes.set(parts[1], parts[2]);
        } else if (parts[0] === "FD:") {
            fields.set(parts[1], parts[2]);
        } else if (parts[0] === "MD:") {
            methods.set(parts[1] + " " + parts[2], parts[3]);
        }
    }
    return { classes, methods, fields };
}

function parseTsrg(content: string): SrgIndex {
    const classes = new Map<string, string>();
    const methods = new Map<string, string>();
    const fields = new Map<string, string>();
    let curObf = "";
    let curSrg = "";
    for (const line of content.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        if (!line.startsWith("\t")) {
            const [obf, srg] = line.trim().split(" ");
            if (obf && srg) { curObf = obf; curSrg = srg; classes.set(obf, srg); }
        } else {
            const parts = line.trim().split(" ");
            if (parts.length === 3) {
                // method: obfName obfDesc srgName
                methods.set(curObf + "/" + parts[0] + " " + parts[1], curSrg + "/" + parts[2]);
            } else if (parts.length === 2) {
                // field: obfName srgName
                fields.set(curObf + "/" + parts[0], curSrg + "/" + parts[1]);
            }
        }
    }
    return { classes, methods, fields };
}

function parseMcpCsv(csv: string): Map<string, string> {
    const map = new Map<string, string>();
    const lines = csv.split("\n");
    // Skip header: searge,name,side,desc
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const comma1 = line.indexOf(",");
        const comma2 = line.indexOf(",", comma1 + 1);
        if (comma1 < 0 || comma2 < 0) continue;
        const searge = line.substring(0, comma1);
        const name = line.substring(comma1 + 1, comma2);
        if (searge && name) map.set(searge, name);
    }
    return map;
}

async function getSrgIndex(version: string): Promise<SrgIndex | null> {
    const key = `srg-${version}`;
    if (srgCache.has(key)) return srgCache.get(key) ?? null;

    const srgPath = join(MAPPINGS_DIR, `srg-${version}.srg`);
    if (!(await exists(srgPath))) {
        // Try joined.srg format first (1.7.10–1.12.2)
        const srgZipPath = join(MAPPINGS_DIR, `mcp-${version}-srg.zip`);
        const srgUrl = `https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp/${version}/mcp-${version}-srg.zip`;
        try {
            await downloadToFile(srgUrl, srgZipPath);
            const zip = new AdmZip(srgZipPath);
            const entry = zip.getEntry("joined.srg");
            if (entry) {
                await ensureDir(srgPath);
                await writeFile(srgPath, entry.getData());
            } else {
                srgCache.set(key, null);
                return null;
            }
        } catch {
            // Try MCPConfig TSRG format (1.13+)
            const tsrgZipPath = join(MAPPINGS_DIR, `mcp_config-${version}.zip`);
            const tsrgUrl = `https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp_config/${version}/mcp_config-${version}.zip`;
            try {
                await downloadToFile(tsrgUrl, tsrgZipPath);
                const zip = new AdmZip(tsrgZipPath);
                const entry = zip.getEntry("config/joined.tsrg");
                if (entry) {
                    const content = entry.getData().toString("utf8");
                    const idx = parseTsrg(content);
                    srgCache.set(key, idx);
                    return idx;
                }
            } catch { /* fall through */ }
            srgCache.set(key, null);
            return null;
        }
    }
    try {
        const content = await readFile(srgPath, "utf8");
        const idx = parseSrg(content);
        srgCache.set(key, idx);
        return idx;
    } catch { srgCache.set(key, null); return null; }
}

async function getMcpNames(version: string): Promise<McpNames | null> {
    const key = `mcp-${version}`;
    if (mcpCache.has(key)) return mcpCache.get(key) ?? null;

    const channel = MCP_CHANNELS[version];
    if (!channel) { mcpCache.set(key, null); return null; }

    const cachedMethods = join(MAPPINGS_DIR, `mcp-methods-${version}.csv`);
    const cachedFields = join(MAPPINGS_DIR, `mcp-fields-${version}.csv`);

    if (!(await exists(cachedMethods)) || !(await exists(cachedFields))) {
        const zipPath = join(MAPPINGS_DIR, `mcp_${channel}.zip`);
        const url = `https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp_stable/${channel}/mcp_stable-${channel}.zip`;
        try {
            await downloadToFile(url, zipPath);
            const zip = new AdmZip(zipPath);
            const methodsEntry = zip.getEntry("methods.csv");
            const fieldsEntry = zip.getEntry("fields.csv");
            if (!methodsEntry || !fieldsEntry) { mcpCache.set(key, null); return null; }
            await ensureDir(cachedMethods);
            await writeFile(cachedMethods, methodsEntry.getData());
            await ensureDir(cachedFields);
            await writeFile(cachedFields, fieldsEntry.getData());
        } catch { mcpCache.set(key, null); return null; }
    }

    try {
        const methodsCsv = await readFile(cachedMethods, "utf8");
        const fieldsCsv = await readFile(cachedFields, "utf8");
        const names: McpNames = {
            methods: parseMcpCsv(methodsCsv),
            fields: parseMcpCsv(fieldsCsv),
        };
        mcpCache.set(key, names);
        return names;
    } catch { mcpCache.set(key, null); return null; }
}

/**
 * Translate a SRG name (func_12345_a / field_12345_b) to its MCP human-readable name.
 */
function translateSrgToMcp(symbol: string, mcpNames: McpNames): TranslateResult {
    const notFound: TranslateResult = { found: false, source: symbol, type: "unknown" };

    // Method: func_12345_a
    if (symbol.startsWith("func_")) {
        const target = mcpNames.methods.get(symbol);
        return target ? { found: true, source: symbol, target, type: "method" } : notFound;
    }

    // Field: field_12345_b
    if (symbol.startsWith("field_")) {
        const target = mcpNames.fields.get(symbol);
        return target ? { found: true, source: symbol, target, type: "field" } : notFound;
    }

    // Try both maps as a fallback
    const mTarget = mcpNames.methods.get(symbol);
    if (mTarget) return { found: true, source: symbol, target: mTarget, type: "method" };
    const fTarget = mcpNames.fields.get(symbol);
    if (fTarget) return { found: true, source: symbol, target: fTarget, type: "field" };

    return notFound;
}

/**
 * Reverse-translate an MCP name back to its SRG name.
 */
function translateMcpToSrg(symbol: string, mcpNames: McpNames): TranslateResult {
    const notFound: TranslateResult = { found: false, source: symbol, type: "unknown" };

    for (const [srg, mcp] of mcpNames.methods) {
        if (mcp === symbol) return { found: true, source: symbol, target: srg, type: "method" };
    }
    for (const [srg, mcp] of mcpNames.fields) {
        if (mcp === symbol) return { found: true, source: symbol, target: srg, type: "field" };
    }
    return notFound;
}

// ── Detect unobfuscated versions (MC 26.1+ ships without obfuscation) ─────────
function isUnobfuscated(version: string): boolean {
    // 26.1+ versioning uses the new unobfuscated scheme
    return /^(?:2[6-9]\.|[3-9]\d\.)/.test(version);
}

// ── Public translation API ────────────────────────────────────────────────────
export async function translateSymbol(
    symbol: string,
    from: MappingNs,
    to: MappingNs,
    version: string,
): Promise<TranslateResult> {
    if (from === to) return { found: true, source: symbol, target: symbol, type: "unknown" };

    if (isUnobfuscated(version)) {
        return {
            found: true,
            source: symbol,
            target: symbol,
            type: "class",
            note: `Version ${version} uses an unobfuscated JAR — all names are already in human-readable (mojmap-equivalent) form. No translation needed.`,
        };
    }

    const normalized = symbol.replace(/\./g, "/");
    const notFound: TranslateResult = { found: false, source: symbol, type: "unknown" };

    try {
        // Direct single-step routes
        if (from === "official" && to === "intermediary") {
            const idx = await getIntermediaryIndex(version);
            if (!idx) return { ...notFound, note: "Intermediary mappings not available" };
            return lookupInIndex(idx, normalized, false);
        }
        if (from === "intermediary" && to === "official") {
            const idx = await getIntermediaryIndex(version);
            if (!idx) return { ...notFound, note: "Intermediary mappings not available" };
            return lookupInIndex(idx, normalized, true);
        }
        if (from === "intermediary" && to === "yarn") {
            const idx = await getYarnIndex(version);
            if (!idx) return { ...notFound, note: "Yarn mappings not available" };
            return lookupInIndex(idx, normalized, false);
        }
        if (from === "yarn" && to === "intermediary") {
            const idx = await getYarnIndex(version);
            if (!idx) return { ...notFound, note: "Yarn mappings not available" };
            return lookupInIndex(idx, normalized, true);
        }
        if (from === "official" && to === "mojmap") {
            const map = await getMojmapClassMap(version);
            if (!map) return { ...notFound, note: "Mojmap not available for this version" };
            const target = map.get(normalized);
            return target ? { found: true, source: symbol, target, type: "class" } : notFound;
        }
        if (from === "mojmap" && to === "official") {
            const map = await getMojmapClassMap(version);
            if (!map) return { ...notFound, note: "Mojmap not available for this version" };
            for (const [off, named] of map) if (named === normalized) return { found: true, source: symbol, target: off, type: "class" };
            return notFound;
        }

        // SRG/MCP direct routes (legacy Forge)
        if (from === "srg" && to === "mcp") {
            const names = await getMcpNames(version);
            if (!names) return { ...notFound, note: `MCP names not available for ${version}. Known versions: ${Object.keys(MCP_CHANNELS).join(", ")}` };
            return translateSrgToMcp(symbol, names);
        }
        if (from === "mcp" && to === "srg") {
            const names = await getMcpNames(version);
            if (!names) return { ...notFound, note: `MCP names not available for ${version}` };
            return translateMcpToSrg(symbol, names);
        }
        if (from === "official" && to === "srg") {
            const idx = await getSrgIndex(version);
            if (!idx) return { ...notFound, note: `SRG mappings not available for ${version}` };
            const cls = idx.classes.get(normalized);
            if (cls) return { found: true, source: symbol, target: cls, type: "class" };
            for (const [from, to] of idx.fields) if (from.endsWith("/" + normalized)) return { found: true, source: symbol, target: to.split("/").pop()!, type: "field" };
            for (const [from, to] of idx.methods) if (from.startsWith(normalized) || from.includes("/" + normalized + " ")) return { found: true, source: symbol, target: to.split("/").pop()!, type: "method" };
            return notFound;
        }
        if (from === "srg" && to === "official") {
            const idx = await getSrgIndex(version);
            if (!idx) return { ...notFound, note: `SRG mappings not available for ${version}` };
            for (const [obf, srg] of idx.classes) if (srg === normalized) return { found: true, source: symbol, target: obf, type: "class" };
            for (const [obf, srg] of idx.fields) if (srg.endsWith("/" + symbol)) return { found: true, source: symbol, target: obf.split("/").pop()!, type: "field" };
            for (const [obf, srg] of idx.methods) if (srg.endsWith("/" + symbol)) return { found: true, source: symbol, target: obf.split("/")[0]?.split(" ")[0]?.split("/").pop()!, type: "method" };
            return notFound;
        }

        // Chained routes via intermediary hub
        const chain = async (steps: Array<[MappingNs, MappingNs]>): Promise<TranslateResult> => {
            let current = normalized;
            let result: TranslateResult = notFound;
            for (const [f, t] of steps) {
                result = await translateSymbol(current, f, t, version);
                if (!result.found || !result.target) return result;
                current = result.target;
            }
            return { ...result, source: symbol };
        };

        if (from === "official"      && to === "yarn")         return chain([["official","intermediary"],["intermediary","yarn"]]);
        if (from === "yarn"          && to === "official")      return chain([["yarn","intermediary"],["intermediary","official"]]);
        if (from === "mojmap"        && to === "intermediary")  return chain([["mojmap","official"],["official","intermediary"]]);
        if (from === "intermediary"  && to === "mojmap")        return chain([["intermediary","official"],["official","mojmap"]]);
        if (from === "yarn"          && to === "mojmap")        return chain([["yarn","official"],["official","mojmap"]]);
        if (from === "mojmap"        && to === "yarn")          return chain([["mojmap","official"],["official","yarn"]]);

        // Chained routes involving SRG/MCP
        if (from === "official"      && to === "mcp")          return chain([["official","srg"],["srg","mcp"]]);
        if (from === "mcp"           && to === "official")     return chain([["mcp","srg"],["srg","official"]]);

        return { ...notFound, note: `Unsupported translation: ${from} → ${to}` };
    } catch (err) {
        return { ...notFound, note: `Translation error: ${err instanceof Error ? err.message : String(err)}` };
    }
}

// ── TinyRemapper ──────────────────────────────────────────────────────────────
export async function ensureTinyRemapper(): Promise<string> {
    if (await exists(TINY_REMAPPER_PATH)) return TINY_REMAPPER_PATH;
    await downloadToFile(TINY_REMAPPER_URL, TINY_REMAPPER_PATH);
    return TINY_REMAPPER_PATH;
}

/** Run java with the given args, return stdout. */
async function runJava(args: string[]): Promise<string> {
    const javaExe = process.env.JAVA_HOME
        ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
        : "java";
    return new Promise((resolve, reject) => {
        const proc = spawn(javaExe, args, { stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        proc.stdout.on("data", (d: Buffer) => out.push(d));
        proc.stderr.on("data", (d: Buffer) => err.push(d));
        proc.on("close", (code) => {
            if (code === 0) resolve(Buffer.concat(out).toString());
            else reject(new Error(Buffer.concat(err).toString().slice(0, 1000)));
        });
        proc.on("error", reject);
    });
}

/**
 * Remap a mod JAR using TinyRemapper.
 * For unobfuscated versions (26.1+) no remapping is required or possible.
 * For older versions, remaps official→yarn or official→mojmap in two steps.
 */
export async function remapJar(
    inputJar: string,
    outputJar: string,
    version: string,
    toMapping: "yarn" | "mojmap",
): Promise<{ outputJar: string; note?: string }> {
    if (isUnobfuscated(version)) {
        return { outputJar: inputJar, note: `Version ${version} is already unobfuscated — no remapping needed. The input JAR IS the output.` };
    }

    const trJar = await ensureTinyRemapper();
    const intIdx   = await getIntermediaryIndex(version);
    if (!intIdx) throw new Error(`Intermediary mappings not available for ${version}`);

    const intTiny = join(MAPPINGS_DIR, `intermediary-${version}.tiny`);

    const stepOneOut = outputJar.replace(/\.jar$/, "-step1.jar");

    // Step 1: official → intermediary
    await runJava(["-jar", trJar, inputJar, stepOneOut, intTiny, "official", "intermediary"]);

    // Step 2: intermediary → named (yarn or mojmap)
    let step2Tiny: string;
    if (toMapping === "yarn") {
        await getYarnIndex(version); // ensure downloaded
        step2Tiny = join(MAPPINGS_DIR, `yarn-${version}.tiny`);
    } else {
        // Mojmap
        await getMojmapClassMap(version); // ensure downloaded
        step2Tiny = join(MAPPINGS_DIR, `mojmap-${version}.tiny`);
        // For mojmap, the proguard inverted tiny doesn't exist yet — build it
        if (!(await exists(step2Tiny))) {
            throw new Error(`Mojmap tiny file not found at ${step2Tiny}. Mojmap remapping via TinyRemapper requires a converted Tiny v2 file. Use a tool like mapping-io to generate it.`);
        }
    }

    await runJava(["-jar", trJar, stepOneOut, outputJar, step2Tiny, "intermediary", "named"]);

    // Cleanup temp file
    const { unlink } = await import("fs/promises");
    await unlink(stepOneOut).catch(() => {});

    return { outputJar };
}

// ── Parchment ─────────────────────────────────────────────────────────────────
async function resolveParchmentVersion(mcVersion: string): Promise<string | null> {
    const metaUrl = `https://maven.parchmentmc.org/org/parchmentmc/data/parchment-${mcVersion}/maven-metadata.xml`;
    try {
        const res = await fetch(metaUrl);
        if (!res.ok) return null;
        const xml = await res.text();
        const m = xml.match(/<(?:latest|release)>([^<]+)<\/(?:latest|release)>/);
        return m ? m[1].trim() : null;
    } catch { return null; }
}

export async function getParchmentData(mcVersion: string): Promise<ParchmentData | null> {
    if (parchmentCache.has(mcVersion)) return parchmentCache.get(mcVersion) ?? null;

    const cachePath = join(PARCHMENT_DIR, `${mcVersion}.json`);

    if (!(await exists(cachePath))) {
        const parchmentVersion = await resolveParchmentVersion(mcVersion);
        if (!parchmentVersion) { parchmentCache.set(mcVersion, null); return null; }

        const zipUrl = `https://maven.parchmentmc.org/org/parchmentmc/data/parchment-${mcVersion}/${parchmentVersion}/parchment-${mcVersion}-${parchmentVersion}-checked.zip`;
        const zipPath = join(PARCHMENT_DIR, `${mcVersion}-${parchmentVersion}.zip`);
        try {
            await downloadToFile(zipUrl, zipPath);
            const zip = new AdmZip(zipPath);
            const entry = zip.getEntry("parchment.json");
            if (!entry) { parchmentCache.set(mcVersion, null); return null; }
            await ensureDir(cachePath);
            await writeFile(cachePath, entry.getData());
        } catch { parchmentCache.set(mcVersion, null); return null; }
    }

    try {
        const raw = JSON.parse(await readFile(cachePath, "utf8")) as {
            classes?: Array<{
                name: string;
                javadoc?: string[];
                fields?: Array<{ name: string; descriptor: string; javadoc?: string[] }>;
                methods?: Array<{
                    name: string;
                    descriptor: string;
                    javadoc?: string[];
                    parameters?: Array<{ index: number; name: string; javadoc?: string }>;
                }>;
            }>;
        };

        const data: ParchmentData = { classes: new Map() };
        for (const cls of raw.classes ?? []) {
            const fieldMap  = new Map<string, ParchmentField>();
            const methodMap = new Map<string, ParchmentMethod>();
            for (const f of cls.fields ?? [])
                fieldMap.set(`${f.name}:${f.descriptor}`, { name: f.name, javadoc: f.javadoc });
            for (const m of cls.methods ?? [])
                methodMap.set(`${m.name}${m.descriptor}`, {
                    name: m.name, descriptor: m.descriptor, javadoc: m.javadoc,
                    parameters: (m.parameters ?? []).map(p => ({ index: p.index, name: p.name, javadoc: p.javadoc })),
                });
            data.classes.set(cls.name, { name: cls.name, javadoc: cls.javadoc, fields: fieldMap, methods: methodMap });
        }
        parchmentCache.set(mcVersion, data);
        return data;
    } catch { parchmentCache.set(mcVersion, null); return null; }
}

export async function getParchmentClass(className: string, mcVersion: string): Promise<ParchmentClass | null> {
    const data = await getParchmentData(mcVersion);
    if (!data) return null;
    return data.classes.get(className.replace(/\./g, "/")) ?? null;
}

export async function listAvailableParchmentVersions(mcVersion: string): Promise<string[]> {
    const metaUrl = `https://maven.parchmentmc.org/org/parchmentmc/data/parchment-${mcVersion}/maven-metadata.xml`;
    try {
        const res = await fetch(metaUrl);
        if (!res.ok) return [];
        const xml = await res.text();
        const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)];
        return matches.map(m => m[1]).filter(v => !v.includes("SNAPSHOT"));
    } catch { return []; }
}

// ── SpecialSource (legacy Forge remapping tool) ───────────────────────────────

export async function ensureSpecialSource(): Promise<string> {
    if (await exists(SPECIAL_SOURCE_PATH)) return SPECIAL_SOURCE_PATH;
    await downloadToFile(SPECIAL_SOURCE_URL, SPECIAL_SOURCE_PATH);
    return SPECIAL_SOURCE_PATH;
}

/**
 * Generate a combined SRG mapping (notch→mcp) for a given MC version.
 * Classes use SRG names (already human-readable: net/minecraft/...).
 * Methods/fields use MCP names where available, SRG names as fallback.
 * Returns the path to the generated .srg file.
 */
export async function generateCombinedSrg(version: string): Promise<string | null> {
    const combined = join(MAPPINGS_DIR, `combined-${version}.srg`);
    if (await exists(combined)) return combined;

    const srgIdx = await getSrgIndex(version);
    if (!srgIdx) return null;

    const mcpNames = await getMcpNames(version);

    const lines: string[] = [];

    // Class mappings: CL: notch srg
    for (const [notch, srg] of srgIdx.classes) {
        lines.push(`CL: ${notch} ${srg}`);
    }

    // Field mappings: FD: notchClass/notchField srgClass/mcpField
    for (const [notchQualified, srgQualified] of srgIdx.fields) {
        if (mcpNames) {
            const srgFieldName = srgQualified.split("/").pop()!;
            const mcpField = mcpNames.fields.get(srgFieldName);
            if (mcpField) {
                const srgClassPath = srgQualified.substring(0, srgQualified.lastIndexOf("/"));
                lines.push(`FD: ${notchQualified} ${srgClassPath}/${mcpField}`);
                continue;
            }
        }
        lines.push(`FD: ${notchQualified} ${srgQualified}`);
    }

    // Method mappings: MD: notchClass/notchMethod notchDesc srgClass/mcpMethod srgDesc
    for (const [notchKey, srgQualified] of srgIdx.methods) {
        // notchKey = "notchClass/notchMethod notchDesc"
        // srgQualified = "srgClass/srgMethod" (no desc stored — reuse notchDesc)
        const spaceIdx = notchKey.indexOf(" ");
        const notchDesc = notchKey.substring(spaceIdx + 1);

        if (mcpNames) {
            const srgMethodName = srgQualified.split("/").pop()!;
            const mcpMethod = mcpNames.methods.get(srgMethodName);
            if (mcpMethod) {
                const srgClassPath = srgQualified.substring(0, srgQualified.lastIndexOf("/"));
                // Remap desc class references too
                const remappedDesc = remapDescriptor(notchDesc, srgIdx.classes);
                lines.push(`MD: ${notchKey} ${srgClassPath}/${mcpMethod} ${remappedDesc}`);
                continue;
            }
        }

        // Fallback: SRG name, remap desc
        const remappedDesc = remapDescriptor(notchDesc, srgIdx.classes);
        lines.push(`MD: ${notchKey} ${srgQualified} ${remappedDesc}`);
    }

    await ensureDir(combined);
    await writeFile(combined, lines.join("\n"));
    return combined;
}

/**
 * Remap class references in a method descriptor using the class mapping.
 * e.g. (La;Lb;)Lc; → (Lnet/minecraft/Foo;Lnet/minecraft/Bar;)Lnet/minecraft/Baz;
 */
function remapDescriptor(desc: string, classMap: Map<string, string>): string {
    return desc.replace(/L([^;]+);/g, (_m, cls) => {
        const mapped = classMap.get(cls);
        return mapped ? `L${mapped};` : `L${cls};`;
    });
}

/**
 * Versions that have SRG+MCP mappings available (legacy Forge era).
 */
export function hasSrgMappings(version: string): boolean {
    return /^1\.(7\.10|8(\.[89])?|9(\.4)?|10\.2|11(\.2)?|12(\.[12])?)$/.test(version);
}

/**
 * Remap a vanilla MC JAR from obfuscated → SRG+MCP names using SpecialSource.
 * Returns the path to the remapped JAR.
 */
export async function remapMcJar(jarPath: string, version: string): Promise<string | null> {
    const remappedPath = jarPath.replace(/\.jar$/, "-mapped.jar");
    if (await exists(remappedPath)) return remappedPath;

    const srgPath = await generateCombinedSrg(version);
    if (!srgPath) return null;

    const ssJar = await ensureSpecialSource();
    await runJava(["-jar", ssJar, "--in-jar", jarPath, "--out-jar", remappedPath, "--srg-in", srgPath]);
    return remappedPath;
}

/**
 * Post-decompile: replace SRG method/field names (func_12345/field_12345) with MCP names.
 * Modifies .java files in-place in the given directory.
 */
export async function applyMcpNamesToSource(sourceDir: string, version: string): Promise<{ replaced: number; files: number }> {
    const mcpNames = await getMcpNames(version);
    if (!mcpNames) return { replaced: 0, files: 0 };

    // Build a combined replacement map (srg→mcp for both methods and fields)
    const replacements = new Map<string, string>();
    for (const [srg, mcp] of mcpNames.methods) replacements.set(srg, mcp);
    for (const [srg, mcp] of mcpNames.fields) replacements.set(srg, mcp);

    if (replacements.size === 0) return { replaced: 0, files: 0 };

    // Build a regex that matches any SRG identifier in one pass
    const srgPattern = /\b(func_\d+_[a-zA-Z_]+|field_\d+_[a-zA-Z_]+)\b/g;

    const { readdir, readFile: rf, writeFile: wf } = await import("fs/promises");
    const { join: pjoin } = await import("path");

    let totalReplaced = 0;
    let totalFiles = 0;

    async function walkAndReplace(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = pjoin(dir, entry.name);
            if (entry.isDirectory()) {
                await walkAndReplace(fullPath);
            } else if (entry.name.endsWith(".java")) {
                const content = await rf(fullPath, "utf8");
                let count = 0;
                const replaced = content.replace(srgPattern, (match) => {
                    const mcp = replacements.get(match);
                    if (mcp) { count++; return mcp; }
                    return match;
                });
                if (count > 0) {
                    await wf(fullPath, replaced);
                    totalReplaced += count;
                    totalFiles++;
                }
            }
        }
    }

    await walkAndReplace(sourceDir);
    return { replaced: totalReplaced, files: totalFiles };
}
