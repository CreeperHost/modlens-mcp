import AdmZip from "adm-zip";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { parse as parseToml } from "smol-toml";

export interface ParsedManifest {
    modId: string;
    displayName: string;
    version: string;
    mcVersion: string;
    loader: "fabric" | "neoforge" | "forge" | "quilt" | "unknown";
    description: string;
    sourceUrl: string | null;
    dependencies: Array<{ id: string; version: string; required: boolean; }>;
    mixinConfigs: string[];
    hasMixins: boolean;
    hasAt: boolean;
    hasAw: boolean;
    atEntries: string[];
    awEntries: string[];
    mixinTargets: string[];
}

export async function parseJar(jarPath: string): Promise<ParsedManifest> {
    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries().map((e) => e.entryName);

    const readEntry = (name: string): string | null => {
        const e = zip.getEntry(name);
        return e ? zip.readFile(e)?.toString("utf8") ?? null : null;
    };

    // Detect loader
    const fabricJson = readEntry("fabric.mod.json");
    const quiltJson = readEntry("quilt.mod.json");
    const neoforgeToml = readEntry("META-INF/neoforge.mods.toml");
    const forgeToml = readEntry("META-INF/mods.toml");

    let manifest: ParsedManifest;

    if (fabricJson) {
        manifest = parseFabric(fabricJson, entries);
    } else if (quiltJson) {
        manifest = parseQuilt(quiltJson, entries);
    } else if (neoforgeToml) {
        manifest = parseNeoForge(neoforgeToml, entries);
    } else if (forgeToml) {
        manifest = parseForge(forgeToml, entries);
    } else {
        manifest = unknownMod(jarPath);
    }

    // AT entries
    const atContent = readEntry("META-INF/accesstransformer.cfg");
    if (atContent) {
        manifest.hasAt = true;
        manifest.atEntries = parseAtEntries(atContent);
    }

    // AW entries — scan all entries for *.accesswidener
    const awEntry = entries.find((e) => e.endsWith(".accesswidener"));
    if (awEntry) {
        const awContent = readEntry(awEntry);
        if (awContent) {
            manifest.hasAw = true;
            manifest.awEntries = parseAwEntries(awContent);
        }
    }

    // Mixin targets — scan *.mixins.json configs
    for (const cfg of manifest.mixinConfigs) {
        const cfgContent = readEntry(cfg);
        if (!cfgContent) continue;
        try {
            const json = JSON.parse(cfgContent) as {
                mixins?: string[];
                client?: string[];
                server?: string[];
                package?: string;
            };
            const pkg = json.package ? json.package + "." : "";
            const allMixins = [
                ...(json.mixins ?? []),
                ...(json.client ?? []),
                ...(json.server ?? []),
            ];
            // We store the config class names; actual targets resolved after decompile
            manifest.mixinTargets.push(...allMixins.map((m) => pkg + m));
        } catch {
            // malformed JSON — skip
        }
    }

    return manifest;
}

function parseFabric(raw: string, entries: string[]): ParsedManifest {
    let json: Record<string, unknown>;
    try { json = JSON.parse(raw); } catch { json = {}; }

    const mixinConfigs = entries.filter((e) => e.endsWith(".mixins.json"));

    const deps: ParsedManifest["dependencies"] = [];
    const rawDeps = (json.depends ?? {}) as Record<string, string>;
    for (const [id, ver] of Object.entries(rawDeps)) {
        deps.push({ id, version: ver, required: true });
    }

    return {
        modId: String(json.id ?? "unknown"),
        displayName: String(json.name ?? json.id ?? "unknown"),
        version: String(json.version ?? "0.0.0"),
        mcVersion: extractFabricMcVersion(rawDeps),
        loader: "fabric",
        description: String(json.description ?? ""),
        sourceUrl: extractString(json, "contact", "sources") ?? extractString(json, "contact", "source"),
        dependencies: deps,
        mixinConfigs,
        hasMixins: mixinConfigs.length > 0,
        hasAt: false,
        hasAw: false,
        atEntries: [],
        awEntries: [],
        mixinTargets: [],
    };
}

function parseQuilt(raw: string, entries: string[]): ParsedManifest {
    let json: Record<string, unknown>;
    try { json = JSON.parse(raw); } catch { json = {}; }
    const ql = (json.quilt_loader ?? {}) as Record<string, unknown>;
    const mixinConfigs = entries.filter((e) => e.endsWith(".mixins.json"));

    return {
        modId: String(ql.id ?? "unknown"),
        displayName: String((ql.metadata as Record<string, unknown>)?.name ?? ql.id ?? "unknown"),
        version: String(ql.version ?? "0.0.0"),
        mcVersion: "",
        loader: "quilt",
        description: "",
        sourceUrl: null,
        dependencies: [],
        mixinConfigs,
        hasMixins: mixinConfigs.length > 0,
        hasAt: false,
        hasAw: false,
        atEntries: [],
        awEntries: [],
        mixinTargets: [],
    };
}

function parseNeoForge(raw: string, entries: string[]): ParsedManifest {
    return parseForgeToml(raw, "neoforge", entries);
}

function parseForge(raw: string, entries: string[]): ParsedManifest {
    return parseForgeToml(raw, "forge", entries);
}

function parseForgeToml(raw: string, loader: "neoforge" | "forge", entries: string[]): ParsedManifest {
    let doc: Record<string, unknown>;
    try {
        doc = parseToml(raw) as Record<string, unknown>;
    } catch {
        doc = {};
    }

    const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

    // [[mods]] array — first entry holds the primary mod info
    const mods = Array.isArray(doc.mods) ? doc.mods as Record<string, unknown>[] : [];
    const mod = mods[0] ?? {};

    const modId = str(mod.modId, "unknown");
    const version = str(mod.version, "0.0.0");
    const displayName = str(mod.displayName, modId);
    const description = str(mod.description);
    const displayUrl = str(mod.displayURL);
    const issueUrl = str(mod.issueTrackerURL);
    const ghMatch = raw.match(/https:\/\/github\.com\/[^\s"']+/);
    const sourceUrl: string | null = displayUrl || issueUrl || (ghMatch ? ghMatch[0] : null);

    // [[dependencies.<modId>]] — flatten all dep arrays, find minecraft range
    const depsTable = (typeof doc.dependencies === "object" && doc.dependencies !== null)
        ? doc.dependencies as Record<string, unknown>
        : {};
    const allDepObjs: Record<string, unknown>[] = [];
    for (const v of Object.values(depsTable)) {
        if (Array.isArray(v)) allDepObjs.push(...v as Record<string, unknown>[]);
    }

    const mcDepEntry = allDepObjs.find((d) => str(d.modId) === "minecraft");
    const mcVersion = str(mcDepEntry?.versionRange);

    const dependencies: ParsedManifest["dependencies"] = allDepObjs
        .filter((d) => {
            const id = str(d.modId);
            return id && id !== "minecraft" && id !== "neoforge" && id !== "forge";
        })
        .map((d) => ({
            id: str(d.modId),
            version: str(d.versionRange, "*"),
            required: d.mandatory !== false,
        }));

    const mixinConfigs = entries.filter((e) => e.endsWith(".mixins.json"));

    return {
        modId,
        displayName,
        version,
        mcVersion,
        loader,
        description,
        sourceUrl,
        dependencies,
        mixinConfigs,
        hasMixins: mixinConfigs.length > 0,
        hasAt: entries.includes("META-INF/accesstransformer.cfg"),
        hasAw: false,
        atEntries: [],
        awEntries: [],
        mixinTargets: [],
    };
}

function unknownMod(jarPath: string): ParsedManifest {
    const name = jarPath.split(/[\\/]/).pop() ?? "unknown";
    return {
        modId: name.replace(/\.jar$/, ""),
        displayName: name,
        version: "0.0.0",
        mcVersion: "",
        loader: "unknown",
        description: "",
        sourceUrl: null,
        dependencies: [],
        mixinConfigs: [],
        hasMixins: false,
        hasAt: false,
        hasAw: false,
        atEntries: [],
        awEntries: [],
        mixinTargets: [],
    };
}

export function parseAtEntries(content: string): string[] {
    return content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
}

export function parseAwEntries(content: string): string[] {
    return content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("accessWidener"));
}

function extractFabricMcVersion(deps: Record<string, string>): string {
    return deps["minecraft"] ?? "";
}

function extractString(obj: unknown, ...keys: string[]): string | null {
    let cur: unknown = obj;
    for (const k of keys) {
        if (typeof cur !== "object" || cur === null) return null;
        cur = (cur as Record<string, unknown>)[k];
    }
    return typeof cur === "string" ? cur : null;
}

export async function computeHashes(jarPath: string): Promise<{ sha256: string; sha512: string; murmur2: string; }> {
    const buf = await readFile(jarPath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const sha512 = createHash("sha512").update(buf).digest("hex");
    const murmur2 = computeMurmur2(buf).toString();
    return { sha256, sha512, murmur2 };
}

/** CurseForge Murmur2 hash — matches CF API fingerprint (whitespace-normalized). */
export function computeMurmur2(data: Buffer): number {
    // Filter whitespace bytes as CF does (9, 10, 13, 32)
    const filtered = Buffer.from(data.filter((b) => b !== 9 && b !== 10 && b !== 13 && b !== 32));
    const seed = 1;
    const m = 0x5bd1e995;
    const r = 24;
    let h = (seed ^ filtered.length) >>> 0;
    let i = 0;
    while (i <= filtered.length - 4) {
        let k = filtered.readUInt32LE(i);
        k = Math.imul(k, m) >>> 0;
        k ^= k >>> r;
        k = Math.imul(k, m) >>> 0;
        h = Math.imul(h, m) >>> 0;
        h ^= k;
        i += 4;
    }
    const remaining = filtered.length - i;
    if (remaining >= 3) h ^= filtered[i + 2] << 16;
    if (remaining >= 2) h ^= filtered[i + 1] << 8;
    if (remaining >= 1) { h ^= filtered[i]; h = Math.imul(h, m) >>> 0; }
    h ^= h >>> 13;
    h = Math.imul(h, m) >>> 0;
    h ^= h >>> 15;
    return h >>> 0;
}
