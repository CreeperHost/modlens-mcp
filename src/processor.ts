import AdmZip from "adm-zip";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { parse as parseToml } from "smol-toml";
import { assertJarPath } from "./security.js";
import { normalizeVersionRange } from "./version-ranges.js";

export type MetadataSource = "fabric.mod.json" | "quilt.mod.json" | "mods.toml" | "mcmod.info" | "@Mod annotation" | "filename";

/** Higher = better quality metadata. Used to decide whether re-parse upgrades an existing record. */
export const METADATA_QUALITY: Record<MetadataSource, number> = {
    "filename":         0,
    "@Mod annotation":  1,
    "mcmod.info":       2,
    "mods.toml":        3,
    "quilt.mod.json":   3,
    "fabric.mod.json":  3,
};

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
    metadataSource: MetadataSource;
}

/** Read every declared loader, including JARs that ship metadata for multiple loaders. */
export async function inspectJarLoaders(jarPath: string): Promise<Array<Exclude<ParsedManifest["loader"], "unknown">>> {
    assertJarPath(jarPath);
    const zip = new AdmZip(jarPath);
    const readEntry = (name: string) => zip.readAsText(name) || null;
    const loaders = new Set<Exclude<ParsedManifest["loader"], "unknown">>();
    const addManifest = (parse: () => ParsedManifest) => {
        try {
            const manifest = parse();
            if (manifest.loader !== "unknown" && manifest.modId && manifest.modId !== "unknown") loaders.add(manifest.loader);
        } catch {
            // Invalid metadata is not loader evidence; another declaration may be valid.
        }
    };
    const fabric = readEntry("fabric.mod.json");
    const quilt = readEntry("quilt.mod.json");
    const forge = readEntry("META-INF/mods.toml");
    const neoforge = readEntry("META-INF/neoforge.mods.toml");
    const legacy = readEntry("mcmod.info");
    if (fabric) addManifest(() => parseFabric(fabric, []));
    if (quilt) addManifest(() => parseQuilt(quilt, []));
    if (forge) addManifest(() => parseForgeToml(forge, "forge", [], readEntry));
    if (neoforge) addManifest(() => parseForgeToml(neoforge, "neoforge", [], readEntry));
    if (legacy) addManifest(() => parseMcModInfo(legacy, []));
    if (!loaders.size) {
        // Annotation-only FML mods have no metadata file. Never guess from a filename.
        try {
            if (extractForgeModAnnotation(zip)?.modId) loaders.add("forge");
        } catch {
            // Unrecognised bytecode provides no loader evidence.
        }
    }
    return [...loaders];
}

export async function parseJar(jarPath: string): Promise<ParsedManifest> {
    assertJarPath(jarPath);
    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries().map((e) => e.entryName);

    const readEntry = (name: string): string | null => {
        const e = zip.getEntry(name);
        return e ? zip.readFile(e)?.toString("utf8") ?? null : null;
    };
    const jarAttributes = parseJarAttributes(readEntry("META-INF/MANIFEST.MF") ?? "");

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
        manifest = parseForgeToml(neoforgeToml, "neoforge", entries, readEntry);
    } else if (forgeToml) {
        manifest = parseForgeToml(forgeToml, "forge", entries, readEntry);
    } else {
        // FML-era mods can provide mcmod.info, an @Mod annotation, or both.
        const mcmodInfoRaw = readEntry("mcmod.info");
        if (mcmodInfoRaw) {
            manifest = parseMcModInfo(mcmodInfoRaw, entries);
        } else {
            // Annotation metadata is also used by mods that omit mcmod.info.
            let modAnnotation: ForgeModAnnotationResult | null = null;
            try {
                modAnnotation = extractForgeModAnnotation(zip);
            } catch {
                // Malformed class files (obfuscators, Kotlin metadata, etc.) — degrade gracefully
            }
            if (modAnnotation) {
                const mixinConfigs = mixinConfigNames(entries);
                manifest = {
                    modId: modAnnotation.modId,
                    displayName: modAnnotation.name,
                    version: modAnnotation.version,
                    mcVersion: modAnnotation.mcVersion,
                    loader: "forge",
                    description: "",
                    sourceUrl: null,
                    dependencies: parseLegacyDependencies(modAnnotation.dependencies.split(";")),
                    mixinConfigs,
                    hasMixins: mixinConfigs.length > 0,
                    hasAt: entries.includes("META-INF/accesstransformer.cfg"),
                    hasAw: false,
                    atEntries: [],
                    awEntries: [],
                    mixinTargets: [],
                    metadataSource: "@Mod annotation",
                };
            } else {
                manifest = unknownMod(jarPath);
            }
        }
    }

    if (manifest.version === "${file.jarVersion}" && jarAttributes["implementation-version"]) {
        manifest.version = jarAttributes["implementation-version"];
    }

    // Legacy FML names AT files in the manifest; later Forge uses a fixed path.
    const atPaths = new Set(["META-INF/accesstransformer.cfg"]);
    for (const name of (jarAttributes.fmlat ?? "").split(/\s+/).filter(Boolean)) {
        atPaths.add(name.startsWith("META-INF/") ? name : `META-INF/${name}`);
    }
    for (const path of atPaths) {
        const content = readEntry(path);
        if (content !== null) {
            manifest.hasAt = true;
            manifest.atEntries.push(...parseAtEntries(content));
        }
    }
    manifest.atEntries = [...new Set(manifest.atEntries)];
    manifest.mixinConfigs = [...new Set([
        ...manifest.mixinConfigs,
        ...(jarAttributes.mixinconfigs ?? "").split(",").map(name => name.trim()).filter(name => entries.includes(name)),
    ])];
    manifest.hasMixins = manifest.mixinConfigs.length > 0;

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

/** JAR manifest main attributes, with continuation lines unfolded per the JAR format. */
function parseJarAttributes(content: string): Record<string, string> {
    const main = content.replace(/\r?\n /g, "").split(/\r?\n\r?\n/, 1)[0];
    const attributes: Record<string, string> = {};
    for (const line of main.split(/\r?\n/)) {
        const separator = line.indexOf(": ");
        if (separator > 0) attributes[line.slice(0, separator).toLowerCase()] = line.slice(separator + 2);
    }
    return attributes;
}

function mixinConfigNames(entries: string[], declared?: unknown): string[] {
    const values = Array.isArray(declared) ? declared : declared ? [declared] : [];
    const names = values.map(value => typeof value === "string" ? value
        : value && typeof value === "object" ? (value as Record<string, unknown>).config : undefined);
    return [...new Set([
        ...names.filter((name): name is string => typeof name === "string" && entries.includes(name)),
        ...entries.filter(name => name.endsWith(".mixins.json") || /(^|\/)mixins\.[^/]+\.json$/.test(name)),
    ])];
}

function parseFabric(raw: string, entries: string[]): ParsedManifest {
    let json: Record<string, unknown>;
    try { json = JSON.parse(raw); } catch { json = {}; }

    const mixinConfigs = mixinConfigNames(entries, json.mixins);

    const deps: ParsedManifest["dependencies"] = [];
    const rawDeps = (json.depends ?? {}) as Record<string, unknown>;
    for (const [id, ver] of Object.entries(rawDeps)) {
        deps.push({ id, version: normalizeVersionRange(ver), required: true });
    }
    for (const field of ["recommends", "suggests"] as const) {
        const optional = json[field];
        if (!optional || typeof optional !== "object") continue;
        for (const [id, ver] of Object.entries(optional)) {
            if (!deps.some(dep => dep.id === id)) deps.push({ id, version: normalizeVersionRange(ver), required: false });
        }
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
        metadataSource: "fabric.mod.json",
    };
}

function parseQuilt(raw: string, entries: string[]): ParsedManifest {
    let json: Record<string, unknown>;
    try { json = JSON.parse(raw); } catch { json = {}; }
    const ql = (json.quilt_loader ?? {}) as Record<string, unknown>;
    const mixinConfigs = mixinConfigNames(entries, json.mixin);
    const metadata = (ql.metadata ?? {}) as Record<string, unknown>;
    const dependencies: ParsedManifest["dependencies"] = [];
    for (const value of Array.isArray(ql.depends) ? ql.depends : []) {
        if (typeof value === "string") dependencies.push({ id: value, version: "*", required: true });
        else if (value && typeof value.id === "string") dependencies.push({
            id: value.id, version: normalizeVersionRange(value.versions) || "*", required: value.optional !== true,
        });
    }

    return {
        modId: String(ql.id ?? "unknown"),
        displayName: String((ql.metadata as Record<string, unknown>)?.name ?? ql.id ?? "unknown"),
        version: String(ql.version ?? "0.0.0"),
        mcVersion: dependencies.find(dep => dep.id === "minecraft")?.version ?? "",
        loader: "quilt",
        description: typeof metadata.description === "string" ? metadata.description : "",
        sourceUrl: extractString(metadata, "contact", "sources"),
        dependencies,
        mixinConfigs,
        hasMixins: mixinConfigs.length > 0,
        hasAt: false,
        hasAw: false,
        atEntries: [],
        awEntries: [],
        mixinTargets: [],
        metadataSource: "quilt.mod.json",
    };
}

function parseForgeToml(
    raw: string, loader: "neoforge" | "forge", entries: string[], readEntry: (name: string) => string | null,
): ParsedManifest {
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
    // Early NeoForge versions still used mods.toml.
    if (modId === "neoforge" || allDepObjs.some(dep => dep.modId === "neoforge")) loader = "neoforge";

    const mcDepEntry = allDepObjs.find((d) => str(d.modId) === "minecraft");
    const mcVersion = str(mcDepEntry?.versionRange);

    const dependencies: ParsedManifest["dependencies"] = allDepObjs
        .filter((d) => {
            const id = str(d.modId);
            return id && id !== "minecraft" && id !== "neoforge" && id !== "forge"
                && d.type !== "incompatible" && d.type !== "discouraged";
        })
        .map((d) => ({
            id: str(d.modId),
            version: str(d.versionRange, "*"),
            required: d.type ? d.type === "required" : d.mandatory !== false,
        }));

    const mixinConfigs = mixinConfigNames(entries, doc.mixins);
    const atEntries: string[] = [];
    for (const at of Array.isArray(doc.accessTransformers) ? doc.accessTransformers : []) {
        if (typeof at?.file !== "string") continue;
        const content = readEntry(at.file);
        if (content !== null) atEntries.push(...parseAtEntries(content));
    }

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
        hasAt: entries.includes("META-INF/accesstransformer.cfg") || atEntries.length > 0,
        hasAw: false,
        atEntries,
        awEntries: [],
        mixinTargets: [],
        metadataSource: "mods.toml",
    };
}

function parseMcModInfo(raw: string, entries: string[]): ParsedManifest {
    let modList: Record<string, unknown>[];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            modList = parsed;
        } else if (parsed?.modList && Array.isArray(parsed.modList)) {
            modList = parsed.modList;
        } else if (parsed?.modid || parsed?.modId) {
            // Bare object format (some 1.6-era mods)
            modList = [parsed];
        } else {
            modList = [];
        }
    } catch {
        return unknownMod("mcmod.info");
    }

    const mod = modList[0];
    if (!mod) return unknownMod("mcmod.info");

    const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
    const modId = str(mod.modid ?? mod.modId, "unknown");

    const mixinConfigs = mixinConfigNames(entries);

    // Dependencies — handle multiple legacy formats
    const rawDeps = Array.isArray(mod.dependencies) ? mod.dependencies : [];
    const rawRequired = Array.isArray(mod.requiredMods) ? mod.requiredMods : [];
    const dependencies = parseLegacyDependencies(rawDeps, rawRequired);

    return {
        modId,
        displayName: str(mod.name, modId),
        version: str(mod.version, "0.0.0"),
        mcVersion: str(mod.mcversion),
        loader: "forge",
        description: str(mod.description),
        sourceUrl: str(mod.url) || null,
        dependencies,
        mixinConfigs,
        hasMixins: mixinConfigs.length > 0,
        hasAt: entries.includes("META-INF/accesstransformer.cfg"),
        hasAw: false,
        atEntries: [],
        awEntries: [],
        mixinTargets: [],
        metadataSource: "mcmod.info",
    };
}

function parseLegacyDependencies(declarations: unknown[], requiredMods: unknown[] = []): ParsedManifest["dependencies"] {
    const dependencies = new Map<string, ParsedManifest["dependencies"][number]>();
    for (const [values, required] of [[declarations, false], [requiredMods, true]] as const) {
        for (const value of values) {
            if (typeof value !== "string") continue;
            const match = value.trim().match(/^(?:(required-(?:after|before)|after|before|required):)?([^@\s;]+)(?:@(.+))?$/i);
            if (!match) continue;
            const [, order = "", id, version = "*"] = match;
            if (["forge", "fml", "mcp", "minecraft", "*"].includes(id.toLowerCase())) continue;
            const previous = dependencies.get(id);
            dependencies.set(id, {
                id, version: version === "*" ? previous?.version ?? "*" : version,
                required: required || order.toLowerCase().startsWith("required") || previous?.required === true,
            });
        }
    }
    return [...dependencies.values()];
}

// ── @Mod annotation extraction from bytecode ──────────────────────────────────

const FORGE_MOD_DESCRIPTORS = new Set([
    "Lcpw/mods/fml/common/Mod;",               // Forge 1.7.10 and earlier
    "Lnet/minecraftforge/fml/common/Mod;",      // Forge 1.8–1.12.2
]);

interface ForgeModAnnotationResult {
    modId: string;
    name: string;
    version: string;
    mcVersion: string;
    dependencies: string;
}

/**
 * Scan class entries in a JAR for the Forge @Mod annotation.
 * Parses the constant pool and RuntimeVisibleAnnotations attribute
 * to extract modid/name/version without requiring javap.
 */
export function extractForgeModAnnotation(zip: AdmZip): ForgeModAnnotationResult | null {
    for (const entry of zip.getEntries()) {
        if (!entry.entryName.endsWith(".class")) continue;
        // Skip inner classes — main mod class is almost never an inner class
        if (entry.entryName.includes("$")) continue;
        // Depth heuristic: @Mod entry points live in the first few package levels.
        // Skip classes nested more than 3 directories deep to avoid scanning
        // hundreds of utility/mixin classes in large mods.
        const slashes = entry.entryName.split("/").length - 1;
        if (slashes > 4) continue;
        const buf = zip.readFile(entry);
        if (!buf || buf.length < 10) continue;
        try {
            const result = parseClassForModAnnotation(buf);
            if (result) return result;
        } catch {
            // Malformed class file (obfuscator artifacts, Kotlin metadata, etc.) — skip it
            continue;
        }
    }
    return null;
}

/** Parse a single .class file's bytes for a Forge @Mod annotation. */
export function parseClassForModAnnotation(buf: Buffer): ForgeModAnnotationResult | null {
    if (buf.length < 10) return null;
    if (buf.readUInt32BE(0) !== 0xCAFEBABE) return null;

    // ── Parse constant pool ──
    let offset = 8; // skip magic(4) + minor(2) + major(2)
    const cpCount = buf.readUInt16BE(offset);
    offset += 2;

    const cpUtf8 = new Map<number, string>();
    let hasModDescriptor = false;

    for (let i = 1; i < cpCount; i++) {
        if (offset >= buf.length) return null;
        const tag = buf[offset++];
        switch (tag) {
            case 1: { // CONSTANT_Utf8
                if (offset + 2 > buf.length) return null;
                const len = buf.readUInt16BE(offset);
                offset += 2;
                if (offset + len > buf.length) return null;
                const str = buf.toString("utf8", offset, offset + len);
                cpUtf8.set(i, str);
                if (FORGE_MOD_DESCRIPTORS.has(str)) hasModDescriptor = true;
                offset += len;
                break;
            }
            case 3: case 4: offset += 4; break;           // Integer, Float
            case 5: case 6: offset += 8; i++; break;      // Long, Double (2 slots)
            case 7: case 8: case 16: case 19: case 20:    // Class, String, MethodType, Module, Package
                offset += 2; break;
            case 9: case 10: case 11: case 12: case 17: case 18: // refs + Dynamic
                offset += 4; break;
            case 15: offset += 3; break;                   // MethodHandle
            default: return null;                          // unknown tag — bail
        }
    }

    if (!hasModDescriptor) return null;

    // ── Skip class header: access_flags, this_class, super_class, interfaces ──
    if (offset + 8 > buf.length) return null;
    offset += 6; // access_flags(2) + this_class(2) + super_class(2)
    const interfaceCount = buf.readUInt16BE(offset);
    offset += 2 + interfaceCount * 2;

    // ── Skip fields ──
    offset = skipClassMembers(buf, offset);
    if (offset < 0) return null;

    // ── Skip methods ──
    offset = skipClassMembers(buf, offset);
    if (offset < 0) return null;

    // ── Parse class-level attributes for RuntimeVisibleAnnotations ──
    if (offset + 2 > buf.length) return null;
    const attrCount = buf.readUInt16BE(offset);
    offset += 2;

    for (let a = 0; a < attrCount; a++) {
        if (offset + 6 > buf.length) return null;
        const nameIdx = buf.readUInt16BE(offset);
        const attrLen = buf.readUInt32BE(offset + 2);
        offset += 6;
        if (cpUtf8.get(nameIdx) === "RuntimeVisibleAnnotations") {
            const result = parseModAnnotationAttr(buf, offset, cpUtf8);
            if (result) return result;
        }
        offset += attrLen;
    }

    return null;
}

function skipClassMembers(buf: Buffer, offset: number): number {
    if (offset + 2 > buf.length) return -1;
    const count = buf.readUInt16BE(offset);
    offset += 2;
    for (let i = 0; i < count; i++) {
        if (offset + 8 > buf.length) return -1;
        offset += 6; // access_flags(2) + name_index(2) + descriptor_index(2)
        const attrCount = buf.readUInt16BE(offset);
        offset += 2;
        for (let a = 0; a < attrCount; a++) {
            if (offset + 6 > buf.length) return -1;
            const attrLen = buf.readUInt32BE(offset + 2);
            offset += 6 + attrLen;
        }
    }
    return offset;
}

function parseModAnnotationAttr(
    buf: Buffer, start: number, cpUtf8: Map<number, string>,
): ForgeModAnnotationResult | null {
    if (start + 2 > buf.length) return null;
    let offset = start;
    const numAnnotations = buf.readUInt16BE(offset);
    offset += 2;

    for (let a = 0; a < numAnnotations; a++) {
        if (offset + 4 > buf.length) return null;
        const typeIdx = buf.readUInt16BE(offset);
        offset += 2;
        const numPairs = buf.readUInt16BE(offset);
        offset += 2;
        const typeStr = cpUtf8.get(typeIdx) ?? "";

        if (FORGE_MOD_DESCRIPTORS.has(typeStr)) {
            // Extract element-value pairs
            const values: Record<string, string> = {};
            for (let p = 0; p < numPairs; p++) {
                if (offset + 3 > buf.length) return null;
                const nameIdx = buf.readUInt16BE(offset);
                offset += 2;
                const elementName = cpUtf8.get(nameIdx) ?? "";
                const ev = readAnnotationElementValue(buf, offset, cpUtf8);
                if (ev.offset < 0) return null;
                offset = ev.offset;
                if (ev.stringValue !== null) values[elementName] = ev.stringValue;
            }
            const modId = values["modid"] ?? values["value"] ?? "";
            if (modId) {
                return {
                    modId,
                    name: values["name"] ?? modId,
                    version: values["version"] ?? "0.0.0",
                    mcVersion: values["acceptedMinecraftVersions"] ?? "",
                    dependencies: values["dependencies"] ?? "",
                };
            }
        } else {
            // Skip non-@Mod annotation pairs
            for (let p = 0; p < numPairs; p++) {
                if (offset + 3 > buf.length) return null;
                offset += 2; // element_name_index
                const ev = readAnnotationElementValue(buf, offset, cpUtf8);
                if (ev.offset < 0) return null;
                offset = ev.offset;
            }
        }
    }
    return null;
}

function readAnnotationElementValue(
    buf: Buffer, offset: number, cpUtf8: Map<number, string>,
): { offset: number; stringValue: string | null } {
    if (offset >= buf.length) return { offset: -1, stringValue: null };
    const tag = buf[offset++];
    switch (tag) {
        case 0x73: { // 's' — String constant
            if (offset + 2 > buf.length) return { offset: -1, stringValue: null };
            const idx = buf.readUInt16BE(offset);
            return { offset: offset + 2, stringValue: cpUtf8.get(idx) ?? null };
        }
        case 0x42: case 0x43: case 0x44: case 0x46: // B, C, D, F
        case 0x49: case 0x4A: case 0x53: case 0x5A:  // I, J, S, Z
            return { offset: offset + 2, stringValue: null };
        case 0x65: // 'e' — Enum
            return { offset: offset + 4, stringValue: null };
        case 0x63: // 'c' — Class
            return { offset: offset + 2, stringValue: null };
        case 0x40: { // '@' — Nested annotation
            if (offset + 4 > buf.length) return { offset: -1, stringValue: null };
            offset += 2; // type_index
            const numPairs = buf.readUInt16BE(offset);
            offset += 2;
            for (let i = 0; i < numPairs; i++) {
                offset += 2; // element_name_index
                const ev = readAnnotationElementValue(buf, offset, cpUtf8);
                if (ev.offset < 0) return { offset: -1, stringValue: null };
                offset = ev.offset;
            }
            return { offset, stringValue: null };
        }
        case 0x5B: { // '[' — Array
            if (offset + 2 > buf.length) return { offset: -1, stringValue: null };
            const numValues = buf.readUInt16BE(offset);
            offset += 2;
            for (let i = 0; i < numValues; i++) {
                const ev = readAnnotationElementValue(buf, offset, cpUtf8);
                if (ev.offset < 0) return { offset: -1, stringValue: null };
                offset = ev.offset;
            }
            return { offset, stringValue: null };
        }
        default:
            return { offset: -1, stringValue: null };
    }
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
        metadataSource: "filename",
    };
}

export function parseAtEntries(content: string): string[] {
    return content
        .split("\n")
        .map((l) => l.split("#", 1)[0].trim())
        .filter((l) => l && !l.startsWith("#"));
}

export function parseAwEntries(content: string): string[] {
    return content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("accessWidener"));
}

function extractFabricMcVersion(deps: Record<string, unknown>): string {
    return normalizeVersionRange(deps["minecraft"]);
}

function extractString(obj: unknown, ...keys: string[]): string | null {
    let cur: unknown = obj;
    for (const k of keys) {
        if (typeof cur !== "object" || cur === null) return null;
        cur = (cur as Record<string, unknown>)[k];
    }
    return typeof cur === "string" ? cur : null;
}

export async function computeHashes(jarPath: string): Promise<{ sha1: string; sha256: string; sha512: string; murmur2: string; }> {
    const buf = await readFile(jarPath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const sha512 = createHash("sha512").update(buf).digest("hex");
    const murmur2 = computeMurmur2(buf).toString();
    return { sha1: createHash("sha1").update(buf).digest("hex"), sha256, sha512, murmur2 };
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
