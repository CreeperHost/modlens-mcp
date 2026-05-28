/**
 * MCP tools for Minecraft mappings and JAR remapping.
 *
 * Tools:
 *   find_mapping    - Translate a symbol name between official/intermediary/yarn/mojmap
 *   remap_mod_jar   - Remap a mod JAR using TinyRemapper (official → yarn or mojmap)
 *   get_parchment   - Get Parchment parameter names + javadocs for a class
 *   list_parchment_versions - List available Parchment builds for a MC version
 */
import { translateSymbol, remapJar, getParchmentClass, listAvailableParchmentVersions, getParchmentData, type MappingNs } from "../mappings.js";
import { assertJarPath } from "../security.js";
import { extname } from "path";

// ── find_mapping ──────────────────────────────────────────────────────────────
export async function findMapping(
    symbol: string,
    version: string,
    sourceNs: MappingNs,
    targetNs: MappingNs,
): Promise<object> {
    const result = await translateSymbol(symbol, sourceNs, targetNs, version);
    return result;
}

// ── remap_mod_jar ─────────────────────────────────────────────────────────────
export async function remapModJar(
    inputJar: string,
    outputJar: string,
    version: string,
    toMapping: "yarn" | "mojmap",
): Promise<object> {
    assertJarPath(inputJar);
    if (extname(outputJar).toLowerCase() !== ".jar") {
        throw new Error("outputJar must have a .jar extension");
    }
    const result = await remapJar(inputJar, outputJar, version, toMapping);
    return {
        success: true,
        inputJar,
        outputJar: result.outputJar,
        mcVersion: version,
        mapping: toMapping,
        note: result.note,
    };
}

// ── get_parchment ─────────────────────────────────────────────────────────────
export async function getParchment(className: string, mcVersion: string): Promise<object> {
    const cls = await getParchmentClass(className, mcVersion);
    if (!cls) {
        return {
            found: false,
            className,
            mcVersion,
            message: `No Parchment data for ${className} in MC ${mcVersion}. Parchment may not have a build for this MC version yet, or the class may not have parameter names documented.`,
        };
    }

    return {
        found: true,
        className: cls.name,
        mcVersion,
        javadoc: cls.javadoc,
        methods: [...cls.methods.entries()].map(([key, m]) => ({
            key,
            name: m.name,
            descriptor: m.descriptor,
            javadoc: m.javadoc,
            parameters: m.parameters,
        })),
        fields: [...cls.fields.entries()].map(([key, f]) => ({
            key,
            name: f.name,
            javadoc: f.javadoc,
        })),
    };
}

// ── list_parchment_versions ───────────────────────────────────────────────────
export async function listParchmentVersions(mcVersion: string): Promise<object> {
    const versions = await listAvailableParchmentVersions(mcVersion);
    return { mcVersion, availableBuilds: versions, count: versions.length };
}

// ── get_parchment_summary ─────────────────────────────────────────────────────
/** Return a summary of all parchment data for a version (class names + counts). */
export async function getParchmentSummary(mcVersion: string): Promise<object> {
    const data = await getParchmentData(mcVersion);
    if (!data) {
        return { found: false, mcVersion, message: "No Parchment data available for this MC version." };
    }
    const classes = [...data.classes.entries()].map(([name, cls]) => ({
        name,
        methodCount:    cls.methods.size,
        fieldCount:     cls.fields.size,
        hasJavadoc:     !!(cls.javadoc?.length),
        paramCount:     [...cls.methods.values()].reduce((s, m) => s + m.parameters.length, 0),
    }));
    return { found: true, mcVersion, classCount: classes.length, classes };
}
