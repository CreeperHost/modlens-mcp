import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ingestMod, decompileMod, decompileModStatus, reindexClasses, batchIngest } from "./tools/ingest.js";
import { listMods, getModDetails, searchMods, getDbStats, getDependencies, findVersionConflicts, getDependencyGraph, listModSourceUrls, listModRegistryEntries } from "./tools/catalog.js";
import {
    listModJarFiles, getModJarFile,
    listModRecipes, getModRecipe,
    listModLootTables, getModLootTable,
    listModAdvancements, getModAdvancement,
    getModBlockstate, listModBlockstates,
    getModModel, listModModels,
    listModBiomes, getModBiome,
    listModStructures, getModStructureData,
    getModLang, getModSounds,
    listModDataTags, getModDataTag,
    listModParticles, getModParticle,
    listModDamageTypes, getModDamageType,
    getModAtlas,
    listModEnchantments, getModEnchantment,
} from "./tools/mod-data.js";
import { getModSource, searchSource, decompileModClass } from "./tools/source.js";
import {
    searchModClass, getModClassMembers, getModClassBytecode,
    findModReferences, getModInheritance, diffModVersions, findImplementors,
} from "./tools/bytecode.js";
import { getMixinTargets, getMixinConflicts, getAtEntries, getAwEntries, resolveMixinTargets } from "./tools/mixins.js";
import { syncModrinth, syncCurseforge, checkUpdates, downloadSource, batchSyncSources } from "./tools/platform.js";
import { listMcVersions, listNeoForgeVersions, listFabricApiVersions, downloadNeoForge, downloadFabricApi } from "./platform.js";
import {
    searchMinecraftClass, getMinecraftSource, getMcClassBytecode, getMcClassMembers,
    findMcReferences, getMcInheritance, diffMcVersions,
    decompileMcVersion, decompileMcVersionStatus, searchMcCode,
    validateAccessWidener, analyzeMixin, searchEvents,
} from "./tools/vanilla.js";
import { indexMcVersion, searchMcIndexed } from "./tools/mc-fts.js";
import { findMapping, remapModJar, getParchment, listParchmentVersions, getParchmentSummary } from "./tools/mappings.js";
import { ingestDocumentation, getDocumentation, searchDocumentation, listDocumentation, deleteDocumentation, seedDefaultDocumentation } from "./tools/docs.js";
import {
    getMcmetaVersions, getMcBlocks, getMcCommands, getMcRegistries, getMcSounds, getMcItemComponents,
    getMcDataFile, getMcAssetFile, listMcDataFiles, diffMcData, getMcAtlas, getMcmetaRaw, getRegistryEntries,
    compareVersions, getVersionChangelog,
} from "./tools/mcmeta.js";
import {
    ingestPrimer, getPrimer, getPrimersByVersionRange, searchPrimers, listPrimers, deletePrimer, seedDefaultPrimers,
} from "./tools/primers.js";
import {
    getMcTags, findTagsForEntry,
    listRecipes, getRecipe, findRecipesForItem,
    listLootTables, getLootTable,
    getLangEntries,
    getBlockstate, getMcModel, getModelTree,
    listBiomes, getBiome,
    listDamageTypes,
    listEnchantments, getEnchantment,
    listAdvancements, getAdvancement,
    listStructures, getStructureData,
    getMcParticles, getParticleData,
    getEntityAttributes,
} from "./tools/vanilla-data.js";
import {
    indexModTags, indexAllModTags, listTagNamespaces, getTagContributors,
    getModTagList, findTagConflicts, searchModTags,
} from "./tools/mod-tags.js";
import {
    listModsWithMixins, getMixinConflictMatrix, getMixinClassDetail, getMixinHotspots, batchResolveMixins,
} from "./tools/mixin-scan.js";
import {
    getModGradleFiles, searchGradleFiles, compareGradleDeps,
} from "./tools/gradle.js";
import { generateReport } from "./tools/reports.js";
import { disconnect } from "./db.js";

// Load .env
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, "");
    }
}

const server = new McpServer({ name: "modlens", version: "1.0.0" });

// ── Mod lifecycle ─────────────────────────────────────────────────────────────

server.tool(
    "ingest_mod",
    "Process a mod JAR: parse manifest, extract mixin/AT/AW info, compute hashes, look up on Modrinth/CurseForge, and store in the database. Also indexes all class names for searching.",
    {
        jarPath: z.string().describe("Absolute path to the mod .jar file"),
        skipSource: z.boolean().optional().default(false).describe("Skip Modrinth/CurseForge source lookup"),
    },
    async ({ jarPath, skipSource }) => {
        const result = await ingestMod(jarPath, skipSource ?? false);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mods",
    "List mods in the database, optionally filtered by loader, MC version, mixin usage, or decompile status.",
    {
        loader: z.enum(["fabric", "neoforge", "forge", "quilt", "unknown"]).optional(),
        mcVersion: z.string().optional().describe("Partial MC version match, e.g. '1.21'"),
        hasMixins: z.boolean().optional(),
        decompiled: z.boolean().optional(),
        limit: z.number().optional().default(50),
    },
    async (opts) => {
        const mods = await listMods(opts);
        return { content: [{ type: "text", text: JSON.stringify(mods, null, 2) }] };
    }
);

server.tool(
    "get_mod_details",
    "Get full metadata for a mod by its database ID or mod_id string.",
    { modId: z.union([z.number(), z.string()]).describe("Database ID (number) or mod_id string") },
    async ({ modId }) => {
        const mod = await getModDetails(modId);
        if (!mod) return { content: [{ type: "text", text: "Mod not found." }] };
        return { content: [{ type: "text", text: JSON.stringify(mod, null, 2) }] };
    }
);

server.tool(
    "search_mods",
    "Search mods by name, mod_id, or description. Supports optional loader and MC version filters.",
    {
        query: z.string().describe("Search query"),
        loader: z.string().optional(),
        mcVersion: z.string().optional(),
        limit: z.number().optional().default(20),
    },
    async (opts) => {
        const results = await searchMods(opts.query, opts);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
);

server.tool(
    "get_dependencies",
    "Get the dependency list for a mod.",
    {
        modId: z.union([z.number(), z.string()]),
        recursive: z.boolean().optional().default(false).describe("Recursively resolve dependencies that are also in the database"),
    },
    async ({ modId, recursive }) => {
        const deps = await getDependencies(modId, recursive ?? false);
        return { content: [{ type: "text", text: JSON.stringify(deps, null, 2) }] };
    }
);

server.tool(
    "get_db_stats",
    "Get database statistics: total mods, decompiled count, loader breakdown, indexed class count.",
    {},
    async () => {
        const stats = await getDbStats();
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }
);

// ── Source / decompile ────────────────────────────────────────────────────────

server.tool(
    "decompile_mod",
    "Decompile an entire mod JAR using Vineflower. Downloads Vineflower automatically on first use. Results cached. Runs in background — call decompile_mod_status to poll for completion.",
    { dbId: z.number().describe("Database ID of the mod") },
    async ({ dbId }) => {
        const result = await decompileMod(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "decompile_mod_status",
    "Check the status of a background decompile job started by decompile_mod. Returns done/running/error/not_started and marks the DB record when complete.",
    { dbId: z.number().describe("Database ID of the mod") },
    async ({ dbId }) => {
        const result = await decompileModStatus(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "decompile_mod_class",
    "Decompile a single class from a mod JAR on demand. Much faster than decompiling the whole JAR.",
    {
        dbId: z.number(),
        className: z.string().describe("Internal class name (slashes or dots), e.g. 'com/example/mymod/MyClass'"),
    },
    async ({ dbId, className }) => {
        const source = await decompileModClass(dbId, className);
        return { content: [{ type: "text", text: source }] };
    }
);

server.tool(
    "get_mod_source",
    "Browse or read decompiled source files for a mod. Omit path for a directory listing.",
    {
        dbId: z.number(),
        path: z.string().optional().describe("Relative path within the decompiled source tree, e.g. 'com/example/mymod/MyClass.java'"),
    },
    async ({ dbId, path }) => {
        const content = await getModSource(dbId, path);
        return { content: [{ type: "text", text: content }] };
    }
);

server.tool(
    "search_source",
    "Search across decompiled source files using text or regex. Can be scoped to a single mod.",
    {
        query: z.string(),
        dbId: z.number().optional().describe("Limit search to a specific mod"),
        isRegex: z.boolean().optional().default(false),
        limit: z.number().optional().default(50),
    },
    async ({ query, dbId, isRegex, limit }) => {
        const results = await searchSource(query, dbId, isRegex ?? false, limit ?? 50);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
);

// ── Bytecode analysis ─────────────────────────────────────────────────────────

server.tool(
    "search_mod_class",
    "Search for a class in a mod JAR by name. Supports CamelCase acronyms, prefix, and substring matching.",
    {
        dbId: z.number(),
        query: z.string().describe("Class name query, e.g. 'MyHandler' or 'MH'"),
    },
    async ({ dbId, query }) => {
        const results = await searchModClass(dbId, query);
        return {
            content: [{
                type: "text",
                text: results.length === 0 ? "No classes found." : results.join("\n"),
            }],
        };
    }
);

server.tool(
    "get_mod_class_members",
    "List all methods and fields for a class in a mod JAR, with @Inject mixin targets, @Shadow annotations, and Access Widener / Access Transformer strings.",
    {
        dbId: z.number(),
        className: z.string().describe("Internal class name (slashes or dots)"),
    },
    async ({ dbId, className }) => {
        const members = await getModClassMembers(dbId, className);
        return { content: [{ type: "text", text: JSON.stringify(members, null, 2) }] };
    }
);

server.tool(
    "get_mod_class_bytecode",
    "Get raw JVM bytecode (javap output) for a class in a mod JAR.",
    {
        dbId: z.number(),
        className: z.string(),
    },
    async ({ dbId, className }) => {
        const bytecode = await getModClassBytecode(dbId, className);
        return { content: [{ type: "text", text: bytecode }] };
    }
);

server.tool(
    "find_mod_references",
    "Find all classes in a mod JAR that reference a given class, method, or field.",
    {
        dbId: z.number(),
        target: z.string().describe(
            "Class: 'com/example/MyClass' | Method: 'com/example/MyClass:myMethod:(I)V' | Field: 'com/example/MyClass:myField:I'"
        ),
    },
    async ({ dbId, target }) => {
        const refs = await findModReferences(dbId, target);
        return {
            content: [{
                type: "text",
                text: refs.length === 0 ? "No references found." : JSON.stringify(refs, null, 2),
            }],
        };
    }
);

server.tool(
    "get_mod_inheritance",
    "Get the inheritance chain for a class in a mod JAR: superclass, interfaces, subclasses, and implementors.",
    {
        dbId: z.number(),
        className: z.string(),
    },
    async ({ dbId, className }) => {
        const result = await getModInheritance(dbId, className);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "diff_mod_versions",
    "Compare two mod JARs (by database ID) and list added and removed classes.",
    {
        dbIdA: z.number().describe("Database ID of the older/first mod version"),
        dbIdB: z.number().describe("Database ID of the newer/second mod version"),
    },
    async ({ dbIdA, dbIdB }) => {
        const result = await diffModVersions(dbIdA, dbIdB);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Mixin analysis ────────────────────────────────────────────────────────────

server.tool(
    "get_mixin_targets",
    "Get the list of Minecraft classes that a mod injects into via @Mixin, plus which mixin config files are present.",
    { modId: z.union([z.number(), z.string()]) },
    async ({ modId }) => {
        const result = await getMixinTargets(modId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "resolve_mixin_targets",
    "Read the @Mixin annotations from a mod's bytecode to discover the actual Minecraft target classes (e.g. 'net/minecraft/world/entity/LivingEntity'). Updates the database so get_mixin_conflicts works correctly. Run once per mod after ingest.",
    { dbId: z.number().describe("Database ID of the mod") },
    async ({ dbId }) => {
        const result = await resolveMixinTargets(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mixin_conflicts",
    "Find all mods in the database that inject into the same Minecraft target class — useful for detecting mixin conflicts.",
    { targetClass: z.string().describe("Internal class name, e.g. 'net/minecraft/world/entity/LivingEntity'") },
    async ({ targetClass }) => {
        const result = await getMixinConflicts(targetClass);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_at_entries",
    "Get all Access Transformer entries declared by a mod (NeoForge/Forge AT format).",
    { dbId: z.number() },
    async ({ dbId }) => {
        const result = await getAtEntries(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_aw_entries",
    "Get all Access Widener entries declared by a mod (Fabric/Quilt AW format).",
    { dbId: z.number() },
    async ({ dbId }) => {
        const result = await getAwEntries(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Platform integration ──────────────────────────────────────────────────────

server.tool(
    "sync_modrinth",
    "Look up a mod on Modrinth by its SHA-512 hash and store the project ID, slug, and source URL.",
    { dbId: z.number() },
    async ({ dbId }) => {
        const result = await syncModrinth(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "sync_curseforge",
    "Look up a mod on CurseForge by its Murmur2 fingerprint and store the project ID, slug, and source URL.",
    { dbId: z.number() },
    async ({ dbId }) => {
        const result = await syncCurseforge(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "check_updates",
    "Check both Modrinth and CurseForge for a newer version of a mod. Returns latest version info from each platform.",
    { dbId: z.number() },
    async ({ dbId }) => {
        const result = await checkUpdates(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "batch_sync_sources",
    "Run Modrinth + CurseForge lookups for all mods that haven't been matched yet, populating source URLs. Optionally also download the actual GitHub source ZIPs. Use modIdFilter and limit to scope the run.",
    {
        syncModrinth:    z.boolean().optional().describe("Run Modrinth SHA-512 lookup (default true)"),
        syncCurseforge:  z.boolean().optional().describe("Run CurseForge Murmur2 lookup (default true)"),
        downloadSources: z.boolean().optional().describe("Also download GitHub source ZIPs for matched mods (default false)"),
        modIdFilter:     z.string().optional().describe("Limit to mods whose modId contains this string"),
        limit:           z.number().optional().describe("Max mods to process (default 500)"),
    },
    async (opts) => {
        const result = await batchSyncSources(opts);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "download_source",
    "Download the GitHub/GitLab source code for a mod (requires sync_modrinth or sync_curseforge to have been run first to discover the source URL).",
    { dbId: z.number() },
    async ({ dbId }) => {
        const outDir = await downloadSource(dbId);
        return { content: [{ type: "text", text: `Source downloaded to: ${outDir}` }] };
    }
);

server.tool(
    "reindex_classes",
    "Index (or re-index) class names for mods that have no class records yet. Run this after batch ingest. Omit dbId to process all un-indexed mods.",
    { dbId: z.number().optional().describe("Limit to a specific mod's database ID") },
    async ({ dbId }) => {
        const result = await reindexClasses(dbId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── MC versions ───────────────────────────────────────────────────────────────

server.tool(
    "list_mc_versions",
    "List Minecraft versions from Mojang's Piston Meta.",
    {
        type: z.enum(["release", "snapshot", "all"]).optional().default("release"),
    },
    async ({ type }) => {
        const versions = await listMcVersions(type ?? "release");
        return { content: [{ type: "text", text: JSON.stringify(versions, null, 2) }] };
    }
);

server.tool(
    "list_neoforge_versions",
    "List NeoForge loader versions from the NeoForge Maven repository. Optionally filter by MC version (e.g. '1.21.1').",
    {
        mcVersion: z.string().optional().describe("Filter by Minecraft version, e.g. '1.21.1'"),
        limit: z.number().optional().default(20),
    },
    async ({ mcVersion, limit }) => {
        const versions = await listNeoForgeVersions(mcVersion, limit ?? 20);
        return { content: [{ type: "text", text: JSON.stringify(versions, null, 2) }] };
    }
);

server.tool(
    "list_fabric_api_versions",
    "List Fabric API versions from Modrinth. Optionally filter by MC version (e.g. '1.21.1').",
    {
        mcVersion: z.string().optional().describe("Filter by Minecraft version, e.g. '1.21.1'"),
        limit: z.number().optional().default(20),
    },
    async ({ mcVersion, limit }) => {
        const versions = await listFabricApiVersions(mcVersion, limit ?? 20);
        return { content: [{ type: "text", text: JSON.stringify(versions, null, 2) }] };
    }
);

server.tool(
    "ingest_neoforge",
    "Download a NeoForge universal JAR from Maven and ingest it into the database. Use list_neoforge_versions to find version strings (e.g. '21.1.228'). Once ingested all bytecode tools work on it: search_mod_class, get_mod_class_members, find_mod_references, get_mod_inheritance, etc.",
    {
        version: z.string().describe("NeoForge version string, e.g. '21.1.228'"),
        skipIndex: z.boolean().optional().default(false).describe("Skip class indexing (faster but search won't work until reindex_classes is run)"),
    },
    async ({ version, skipIndex }) => {
        const jarPath = await downloadNeoForge(version);
        const result = await ingestMod(jarPath, true);
        if (result.status === "already_ingested") {
            return { content: [{ type: "text", text: `Already ingested. DB id: ${(result.mod as { id: number; }).id}` }] };
        }
        const mod = result.mod as { id: number; modId: string; };
        if (!skipIndex) await reindexClasses(mod.id);
        return { content: [{ type: "text", text: JSON.stringify({ ...result, jarPath }, null, 2) }] };
    }
);

server.tool(
    "ingest_fabric_api",
    "Download a Fabric API JAR from Modrinth and ingest it into the database. Use list_fabric_api_versions to find version strings (e.g. '0.116.11+1.21.1'). Once ingested all bytecode tools work on it.",
    {
        version: z.string().describe("Fabric API version string, e.g. '0.116.11+1.21.1'"),
        skipIndex: z.boolean().optional().default(false).describe("Skip class indexing"),
    },
    async ({ version, skipIndex }) => {
        const jarPath = await downloadFabricApi(version);
        const result = await ingestMod(jarPath, true);
        if (result.status === "already_ingested") {
            return { content: [{ type: "text", text: `Already ingested. DB id: ${(result.mod as { id: number; }).id}` }] };
        }
        const mod = result.mod as { id: number; modId: string; };
        if (!skipIndex) await reindexClasses(mod.id);
        return { content: [{ type: "text", text: JSON.stringify({ ...result, jarPath }, null, 2) }] };
    }
);

// ── Vanilla Minecraft analysis ────────────────────────────────────────────────

server.tool(
    "search_minecraft_class",
    "Search for a class in a vanilla Minecraft JAR by name. Supports CamelCase acronyms (e.g. 'LE' → LivingEntity), prefix, and substring matching. Downloads the JAR automatically on first use.",
    {
        version: z.string().describe("MC version ID, e.g. '26.1.2' or '1.21.4'"),
        query: z.string().describe("Class name query"),
    },
    async ({ version, query }) => {
        const results = await searchMinecraftClass(version, query);
        return { content: [{ type: "text", text: results.length === 0 ? "No classes found." : results.join("\n") }] };
    }
);

server.tool(
    "get_minecraft_source",
    "Get decompiled Java source for a vanilla Minecraft class. Downloads + decompiles automatically on first use (cached). Optional line-range parameters to return only a slice of the file.",
    {
        version: z.string().describe("MC version ID, e.g. '26.1.2'"),
        className: z.string().describe("Internal class name (slashes or dots), e.g. 'net/minecraft/world/entity/LivingEntity'"),
        startLine: z.number().optional().describe("First line to return (1-based, inclusive)"),
        endLine: z.number().optional().describe("Last line to return (1-based, inclusive)"),
        maxLines: z.number().optional().describe("Maximum lines to return (used when only startLine is given)"),
    },
    async ({ version, className, startLine, endLine, maxLines }) => {
        const source = await getMinecraftSource(version, className, startLine, endLine, maxLines);
        return { content: [{ type: "text", text: source }] };
    }
);

server.tool(
    "get_mc_class_bytecode",
    "Get raw JVM bytecode (javap output) for a vanilla Minecraft class. Useful for verifying method signatures.",
    {
        version: z.string().describe("MC version ID"),
        className: z.string().describe("Internal class name, e.g. 'net/minecraft/world/entity/LivingEntity'"),
    },
    async ({ version, className }) => {
        const bytecode = await getMcClassBytecode(version, className);
        return { content: [{ type: "text", text: bytecode }] };
    }
);

server.tool(
    "get_mc_class_members",
    "List all methods and fields of a vanilla Minecraft class with @Inject mixin target strings, @Shadow annotations, and Access Widener / Access Transformer strings.",
    {
        version: z.string().describe("MC version ID"),
        className: z.string().describe("Internal class name, e.g. 'net/minecraft/world/entity/LivingEntity'"),
    },
    async ({ version, className }) => {
        const members = await getMcClassMembers(version, className);
        return { content: [{ type: "text", text: JSON.stringify(members, null, 2) }] };
    }
);

server.tool(
    "find_mc_references",
    "Find all classes in a vanilla Minecraft JAR that reference a given class, method, or field. Target formats: class 'net/minecraft/X', method 'net/minecraft/X:tick:()V', field 'net/minecraft/X:id:I'. Builds and caches an index on first call per version.",
    {
        version: z.string().describe("MC version ID"),
        target: z.string().describe("Class, method, or field reference target"),
    },
    async ({ version, target }) => {
        const result = await findMcReferences(version, target);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_inheritance",
    "Get the full inheritance hierarchy of a vanilla Minecraft class: superclass, interfaces, direct subclasses, and implementors.",
    {
        version: z.string().describe("MC version ID"),
        className: z.string().describe("Internal class name, e.g. 'net/minecraft/world/entity/LivingEntity'"),
    },
    async ({ version, className }) => {
        const result = await getMcInheritance(version, className);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "diff_minecraft_versions",
    "Compare two vanilla Minecraft versions and list added and removed classes.",
    {
        versionA: z.string().describe("Earlier version, e.g. '26.1.1'"),
        versionB: z.string().describe("Later version, e.g. '26.1.2'"),
    },
    async ({ versionA, versionB }) => {
        const result = await diffMcVersions(versionA, versionB);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "decompile_minecraft_version",
    "Bulk-decompile an entire vanilla Minecraft JAR using Vineflower. Runs in the background — returns immediately with status 'started'. Required before search_minecraft_code or index_minecraft_version.",
    {
        version: z.string().describe("MC version ID, e.g. '26.1.2'"),
        force: z.boolean().optional().default(false).describe("Re-decompile even if already done"),
    },
    async ({ version, force }) => {
        const result = await decompileMcVersion(version, force ?? false);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "decompile_minecraft_version_status",
    "Check the status of a background decompile started by decompile_minecraft_version. Returns done/running/error/not_started.",
    {
        version: z.string().describe("MC version ID"),
    },
    async ({ version }) => {
        const result = await decompileMcVersionStatus(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "search_minecraft_code",
    "Regex or text search across all decompiled vanilla Minecraft source files. Requires decompile_minecraft_version to have completed first. searchType: 'class' matches class/interface declarations, 'method' matches method signatures, 'field' matches field declarations, 'content'/'all' searches raw file body.",
    {
        version: z.string().describe("MC version ID"),
        query: z.string().describe("Search query (plain text or regex when isRegex=true)"),
        searchType: z.enum(["class", "method", "field", "content", "all"]).default("content"),
        isRegex: z.boolean().optional().default(false),
        limit: z.number().optional().default(50),
    },
    async ({ version, query, searchType, isRegex, limit }) => {
        const results = await searchMcCode(version, query, searchType, isRegex ?? false, limit ?? 50);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
);

server.tool(
    "validate_access_widener",
    "Validate a Fabric/Quilt Access Widener file against a vanilla Minecraft version. Checks every class, method, and field target exists in the JAR. Returns errors with similarity suggestions for typos.",
    {
        content: z.string().describe("Full text content of the .accesswidener file"),
        mcVersion: z.string().describe("MC version ID to validate against, e.g. '26.1.2'"),
    },
    async ({ content, mcVersion }) => {
        const result = await validateAccessWidener(content, mcVersion);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "analyze_mixin",
    "Parse and validate a Mixin class against vanilla Minecraft source. Extracts @Mixin target, all @Inject/@Redirect/@ModifyArg/@Overwrite method targets, and @Shadow declarations. Validates each against the decompiled MC class and reports errors with suggestions.",
    {
        source: z.string().describe("Full Java source code of the mixin class"),
        mcVersion: z.string().describe("MC version ID to validate against, e.g. '26.1.2'"),
    },
    async ({ source, mcVersion }) => {
        const result = await analyzeMixin(source, mcVersion);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "index_minecraft_version",
    "Index a decompiled vanilla Minecraft version into PostgreSQL for fast full-text search. Requires decompile_minecraft_version to be done first. Run once per version — subsequent search_mc_indexed calls are instant.",
    {
        version: z.string().describe("MC version ID, e.g. '26.1.2'"),
        force: z.boolean().optional().default(false).describe("Re-index even if already indexed"),
    },
    async ({ version, force }) => {
        const result = await indexMcVersion(version, force ?? false);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "search_mc_indexed",
    "Fast full-text search across indexed vanilla Minecraft source using PostgreSQL FTS. Supports keywords, AND/OR phrases. Much faster than search_minecraft_code for broad queries. Run index_minecraft_version first.",
    {
        query: z.string().describe("Search query — plain keywords or boolean: 'Entity AND tick', 'hurt damage'"),
        version: z.string().describe("MC version ID, e.g. '26.1.2'"),
        limit: z.number().optional().default(20),
    },
    async ({ query, version, limit }) => {
        const results = await searchMcIndexed(query, version, limit ?? 20);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
);

// ── Start ─────────────────────────────────────────────────────────────────────

// ── Mappings ──────────────────────────────────────────────────────────────────

server.tool(
    "find_mapping",
    "Translate a Minecraft symbol (class, method, or field name) between naming namespaces: official (obfuscated), intermediary (Fabric stable), yarn (Fabric human-readable), mojmap (Mojang ProGuard names). For MC 26.1+ the JAR is already unobfuscated so no translation is needed.",
    {
        symbol:    z.string().describe("Symbol to translate, e.g. a class like 'net/minecraft/world/entity/Entity' or a method name like 'tick'"),
        version:   z.string().describe("Minecraft version, e.g. '1.21.1' or '26.1.2'"),
        sourceNs:  z.enum(["official", "intermediary", "yarn", "mojmap"]).describe("Source namespace"),
        targetNs:  z.enum(["official", "intermediary", "yarn", "mojmap"]).describe("Target namespace"),
    },
    async ({ symbol, version, sourceNs, targetNs }) => {
        const result = await findMapping(symbol, version, sourceNs, targetNs);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "remap_mod_jar",
    "Remap a mod JAR from obfuscated (official) names to yarn or mojmap using TinyRemapper. Downloads TinyRemapper and mapping data automatically. For MC 26.1+ (unobfuscated) this is a no-op and returns the input path.",
    {
        inputJar:  z.string().describe("Absolute path to the input JAR to remap"),
        outputJar: z.string().describe("Absolute path for the remapped output JAR"),
        version:   z.string().describe("Minecraft version the mod targets, e.g. '1.21.1'"),
        toMapping: z.enum(["yarn", "mojmap"]).describe("Target mapping namespace"),
    },
    async ({ inputJar, outputJar, version, toMapping }) => {
        const result = await remapModJar(inputJar, outputJar, version, toMapping);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_parchment",
    "Get Parchment parameter names and javadocs for a specific class in a Minecraft version. Parchment enriches mojmap names with community-documented parameter names. Class name should be slash-separated: 'net/minecraft/world/entity/Entity'.",
    {
        className: z.string().describe("Class name in slash or dot form, e.g. 'net/minecraft/world/entity/Entity'"),
        mcVersion: z.string().describe("Minecraft version, e.g. '1.21.1'"),
    },
    async ({ className, mcVersion }) => {
        const result = await getParchment(className, mcVersion);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_parchment_versions",
    "List available Parchment mapping builds for a Minecraft version from the ParchmentMC Maven repository.",
    {
        mcVersion: z.string().describe("Minecraft version, e.g. '1.21.1'"),
    },
    async ({ mcVersion }) => {
        const result = await listParchmentVersions(mcVersion);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_parchment_summary",
    "Return a summary of all classes with Parchment data for a given Minecraft version (class names + method/field/param counts). Useful for gauging parchment coverage before calling get_parchment on individual classes.",
    {
        mcVersion: z.string().describe("Minecraft version, e.g. '1.21.1'"),
    },
    async ({ mcVersion }) => {
        const result = await getParchmentSummary(mcVersion);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Documentation ─────────────────────────────────────────────────────────────

server.tool(
    "ingest_documentation",
    "Add one or more documentation entries to the database. Each entry has a URL, title, optional class name (for MC class-specific docs), category (minecraft|neoforge|fabric|forge|quilt|mod|other), namespace, and tags. Existing entries with the same URL+className are updated in place.",
    {
        entries: z.array(z.object({
            className: z.string().optional().describe("Fully-qualified class name (dot or slash separated)"),
            title:     z.string().describe("Human-readable title"),
            summary:   z.string().optional().describe("Short summary / description"),
            url:       z.string().describe("URL to the documentation page"),
            category:  z.enum(["minecraft", "neoforge", "fabric", "forge", "quilt", "mod", "other"]).optional().default("minecraft"),
            namespace: z.string().optional().default("vanilla").describe("namespace tag, e.g. vanilla|neoforge|fabric|forge|parchment"),
            tags:      z.array(z.string()).optional().default([]),
            source:    z.string().optional().default("manual"),
        })).min(1).describe("One or more documentation entries to ingest"),
    },
    async ({ entries }) => {
        const result = await ingestDocumentation(entries);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "seed_default_documentation",
    "Populate the documentation database with the built-in defaults: ~20 Fabric/vanilla MC class entries, Fabric wiki topics, NeoForge docs pages, and mapping reference links. Safe to run multiple times — existing entries are updated, not duplicated.",
    {},
    async () => {
        const result = await seedDefaultDocumentation();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_documentation",
    "Look up documentation for a Minecraft class name or keyword. Searches class name first, then falls back to title/summary keyword search.",
    {
        query: z.string().describe("Class name (e.g. 'net.minecraft.entity.Entity') or keyword"),
    },
    async ({ query }) => {
        const result = await getDocumentation(query);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "search_documentation",
    "Full-text search across all documentation entries (title, summary, class name). Optionally filter by category or namespace.",
    {
        query:     z.string().describe("Search keywords"),
        category:  z.string().optional().describe("Filter by category: minecraft|neoforge|fabric|forge|quilt|mod|other"),
        namespace: z.string().optional().describe("Filter by namespace: vanilla|neoforge|fabric|forge|parchment"),
    },
    async ({ query, category, namespace }) => {
        const result = await searchDocumentation(query, category, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_documentation",
    "List all documentation entries. Filter by category, namespace, or tag. Returns up to 100 entries by default.",
    {
        category:  z.string().optional().describe("Filter by category"),
        namespace: z.string().optional().describe("Filter by namespace"),
        tag:       z.string().optional().describe("Filter by tag (exact match on any tag in the tags array)"),
        limit:     z.number().optional().default(100),
    },
    async ({ category, namespace, tag, limit }) => {
        const result = await listDocumentation(category, namespace, tag, limit ?? 100);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "delete_documentation",
    "Delete a documentation entry by its database ID. Use list_documentation or get_documentation to find the ID first.",
    {
        id: z.number().describe("Database ID of the doc entry to delete"),
    },
    async ({ id }) => {
        const result = await deleteDocumentation(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── mcmeta ────────────────────────────────────────────────────────────────────

server.tool(
    "get_mcmeta_versions",
    "List all Minecraft versions tracked by misode/mcmeta, including data_version, resource_pack_version, and release date. Filter by 'release', 'snapshot', or 'all'.",
    {
        filter: z.enum(["release", "snapshot", "all"]).optional().default("all"),
    },
    async ({ filter }) => {
        const result = await getMcmetaVersions(filter ?? "all");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_blocks",
    "Get block state property definitions (valid values and defaults) for a Minecraft version from misode/mcmeta.",
    {
        version: z.string().optional().describe("MC version ID. Omit for latest."),
    },
    async ({ version }) => {
        const result = await getMcBlocks(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_commands",
    "Get the full Brigadier command tree for a Minecraft version from misode/mcmeta.",
    {
        version: z.string().optional().describe("MC version ID. Omit for latest."),
    },
    async ({ version }) => {
        const result = await getMcCommands(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_registries",
    "Get registry contents for a Minecraft version. With no registry specified returns all registry keys; with a registry specified returns its entries.",
    {
        version:  z.string().optional().describe("MC version ID. Omit for latest."),
        registry: z.string().optional().describe("Registry key, e.g. 'block', 'item', 'entity_type'. Supports both 'block' and 'minecraft:block' formats."),
    },
    async ({ version, registry }) => {
        const result = await getMcRegistries(version, registry);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_sounds",
    "Get the sounds.json registry (all sound event IDs and their variants) for a Minecraft version from misode/mcmeta.",
    {
        version: z.string().optional().describe("MC version ID. Omit for latest."),
    },
    async ({ version }) => {
        const result = await getMcSounds(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_item_components",
    "Get item component definitions (data-driven item properties) for a Minecraft version from misode/mcmeta.",
    {
        version: z.string().optional().describe("MC version ID. Omit for latest."),
    },
    async ({ version }) => {
        const result = await getMcItemComponents(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_data_file",
    "Fetch a specific file from the vanilla datapack (data branch) for a Minecraft version. Use list_mc_data_files to explore available paths.",
    {
        filePath: z.string().describe("Relative path within the branch, e.g. 'minecraft/recipes/iron_sword.json'"),
        version:  z.string().optional().describe("MC version ID. Omit for latest."),
        jsonOnly: z.boolean().optional().default(false).describe("Use the data-json branch (JSON files only, smaller)"),
    },
    async ({ filePath, version, jsonOnly }) => {
        const result = await getMcDataFile(filePath, version, jsonOnly ?? false);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_asset_file",
    "Fetch a specific file from the vanilla resource pack (assets branch) for a Minecraft version. Binary files (png, ogg) are cached to disk and the local path is returned.",
    {
        filePath: z.string().describe("Relative path within the branch, e.g. 'minecraft/models/block/stone.json'"),
        version:  z.string().optional().describe("MC version ID. Omit for latest."),
        jsonOnly: z.boolean().optional().default(false).describe("Use the assets-json branch (JSON only, no textures/sounds)"),
    },
    async ({ filePath, version, jsonOnly }) => {
        const result = await getMcAssetFile(filePath, version, jsonOnly ?? false);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mc_data_files",
    "List files/directories within a path on a given mcmeta branch and Minecraft version. Reads from local cache if available, otherwise queries the GitHub tree API.",
    {
        dirPath: z.string().describe("Directory path to list, e.g. 'minecraft/recipes' or '' for root"),
        version: z.string().describe("MC version ID, e.g. '26.1.2'"),
        branch:  z.enum(["data", "data-json", "assets", "assets-json", "assets-tiny", "registries", "summary", "diff", "atlas"]).describe("mcmeta branch"),
    },
    async ({ dirPath, version, branch }) => {
        const result = await listMcDataFiles(dirPath, version, branch);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "diff_mc_data",
    "Compare a data or asset file between two Minecraft versions using misode/mcmeta. Returns the raw content from each version side-by-side.",
    {
        filePath: z.string().describe("Path to the file within the branch"),
        versionA: z.string().describe("First MC version"),
        versionB: z.string().describe("Second MC version"),
        branch:   z.enum(["data", "data-json", "assets", "assets-json", "registries", "summary"]).optional().default("data"),
    },
    async ({ filePath, versionA, versionB, branch }) => {
        const result = await diffMcData(filePath, versionA, versionB, branch ?? "data");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_atlas",
    "Get texture atlas definitions for a Minecraft version from the mcmeta atlas branch. Atlases describe which textures go into each sprite sheet (blocks, items, etc.).",
    {
        version: z.string().optional().describe("MC version ID. Omit for latest."),
        atlas:   z.string().optional().describe("Atlas name, e.g. 'blocks', 'items'. Omit to list all available atlases."),
    },
    async ({ version, atlas }) => {
        const result = await getMcAtlas(version, atlas);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_registry_entries",
    "Get all entries for a specific Minecraft registry from the mcmeta registries branch. More complete than get_mc_registries for specific registry contents.",
    {
        registry: z.string().describe("Registry key, e.g. 'block', 'item', 'entity_type', 'biome'"),
        version:  z.string().optional().describe("MC version ID. Omit for latest."),
    },
    async ({ registry, version }) => {
        const result = await getRegistryEntries(registry, version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mc_entities",
    "List all vanilla Minecraft entity types from the entity_type registry. Shortcut for get_mc_registry_entries with registry='entity_type'.",
    {
        version: z.string().optional().describe("MC version ID. Omit for latest."),
    },
    async ({ version }) => {
        const result = await getRegistryEntries("entity_type", version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mc_items",
    "List all vanilla Minecraft items from the item registry. Shortcut for get_mc_registry_entries with registry='item'.",
    {
        version: z.string().optional().describe("MC version ID. Omit for latest."),
    },
    async ({ version }) => {
        const result = await getRegistryEntries("item", version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mcmeta_raw",
    "Fetch any raw file from misode/mcmeta by specifying the full git ref and file path. Useful for branches/paths not covered by other tools.",
    {
        ref:      z.string().describe("Git ref, e.g. '26.1.2-data', '26.1.2-summary', 'summary'"),
        filePath: z.string().describe("Path within the ref, e.g. 'minecraft/recipes/iron_sword.json'"),
    },
    async ({ ref, filePath }) => {
        const result = await getMcmetaRaw(ref, filePath);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "compare_mc_versions",
    "Compare two Minecraft versions using the GitHub compare API on the given mcmeta branch. Returns a list of files added, modified, and removed. Use the 'diff' branch for a combined view of all changes (data+assets+summary). Results are cached locally. Note: GitHub API caps at 300 files per comparison.",
    {
        versionA: z.string().describe("Earlier MC version, e.g. '1.21.1'"),
        versionB: z.string().describe("Newer MC version, e.g. '26.1.2'"),
        branch:   z.string().optional().describe("Branch to compare on: diff (default), data, assets, summary, registries"),
    },
    async ({ versionA, versionB, branch }) => {
        const result = await compareVersions(versionA, versionB, branch);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_version_changelog",
    "Get the list of files changed in a specific Minecraft version compared to the previous version, using the mcmeta GitHub commit for that version. Shows what was added, modified, or removed. Uses the 'diff' branch by default which combines data+assets+summary changes.",
    {
        version: z.string().describe("Minecraft version, e.g. '26.1.2'"),
        branch:  z.string().optional().describe("Branch to check: diff (default), data, assets, summary"),
    },
    async ({ version, branch }) => {
        const result = await getVersionChangelog(version, branch);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Primers ───────────────────────────────────────────────────────────────────

server.tool(
    "ingest_primer",
    "Add one or more version migration primers to the database. Primers document how to migrate mods between Minecraft/loader versions (e.g. NeoForge migration guides, Forge breaking changes). fromVersion and toVersion should be Minecraft version IDs like '1.21.1' or '26.1.2'. Set fetchContent=true to automatically download and store the full text of the primer URL.",
    {
        entries: z.array(z.object({
            fromVersion:  z.string().describe("Starting MC version, e.g. '1.20.4'"),
            toVersion:    z.string().describe("Target MC version, e.g. '1.21.1'"),
            modloader:    z.string().optional().describe("neoforge | forge | fabric | quilt | vanilla | other"),
            title:        z.string(),
            summary:      z.string().optional(),
            url:          z.string().describe("URL to the primer/migration guide"),
            content:      z.string().optional().describe("Full text content (optional)"),
            tags:         z.array(z.string()).optional(),
            source:       z.string().optional().describe("manual | seed | scraped"),
            fetchContent: z.boolean().optional().describe("If true, auto-fetch and store the primer URL text"),
        })).describe("One or more primer entries to ingest"),
    },
    async ({ entries }) => {
        const result = await ingestPrimer(entries);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_primer",
    "Get a specific primer by its database ID.",
    { id: z.number().describe("Primer database ID") },
    async ({ id }) => {
        const result = await getPrimer(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_primers_by_version_range",
    "Get all primers that cover a given Minecraft version range. For example, fromVersion='1.20.4' toVersion='26.1.2' returns every migration guide that falls within or overlaps that span. Uses numeric data_version comparison when possible for accuracy. Optionally filter by modloader (neoforge|forge|fabric|quilt).",
    {
        fromVersion: z.string().describe("Start of range, e.g. '1.20.4'"),
        toVersion:   z.string().describe("End of range, e.g. '26.1.2'"),
        modloader:   z.string().optional().describe("Filter by loader: neoforge | forge | fabric | quilt"),
    },
    async ({ fromVersion, toVersion, modloader }) => {
        const result = await getPrimersByVersionRange(fromVersion, toVersion, modloader);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "search_primers",
    "Full-text search primers by keyword. Searches title, summary, content, and tags. Optionally filter by modloader and/or a version range.",
    {
        query:       z.string().describe("Search keyword(s)"),
        modloader:   z.string().optional(),
        fromVersion: z.string().optional().describe("Minimum MC version (inclusive)"),
        toVersion:   z.string().optional().describe("Maximum MC version (inclusive)"),
        limit:       z.number().optional().describe("Max results (default 20)"),
    },
    async ({ query, modloader, fromVersion, toVersion, limit }) => {
        const result = await searchPrimers(query, modloader, fromVersion, toVersion, limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_primers",
    "List all primers in the database, optionally filtered by modloader. Returns id, version range, title, summary, and URL.",
    {
        modloader: z.string().optional().describe("Filter by loader: neoforge | forge | fabric | quilt | all"),
        limit:     z.number().optional().describe("Max results (default 50)"),
    },
    async ({ modloader, limit }) => {
        const result = await listPrimers(modloader, limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "delete_primer",
    "Remove a primer from the database by ID.",
    { id: z.number().describe("Primer database ID") },
    async ({ id }) => {
        const result = await deletePrimer(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "seed_default_primers",
    "Populate the primers database with the built-in defaults: NeoForge migration guides (1.20.1→26.1.2), MinecraftForge primers (1.18.2→1.20.1), and Fabric migration notes. Safe to run multiple times — existing entries are updated, not duplicated.",
    {},
    async () => {
        const result = await seedDefaultPrimers();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Vanilla data browsers ────────────────────────────────────────────────────

server.tool(
    "get_mc_tags",
    "Browse vanilla MC tags from the mcmeta data branch. No args: list tag registries. Registry only: list all tag IDs. Registry + tagId: return full tag values array.",
    {
        version:   z.string().optional().describe("MC version (default 26.1.2)"),
        registry:  z.string().optional().describe("Tag registry: block | item | entity_type | fluid | game_event | …"),
        tagId:     z.string().optional().describe("Specific tag ID within the registry, e.g. 'logs', 'planks'"),
        namespace: z.string().optional().describe("Namespace (default minecraft)"),
    },
    async ({ version, registry, tagId, namespace }) => {
        const result = await getMcTags(version, registry, tagId, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "find_tags_for_entry",
    "Reverse tag lookup: find all tags in a registry that contain a specific entry. E.g. find all block tags that include 'minecraft:iron_ore'.",
    {
        entry:     z.string().describe("Entry to search for, e.g. 'minecraft:iron_ore' or 'iron_ore'"),
        registry:  z.string().describe("Tag registry: block | item | entity_type | fluid | …"),
        version:   z.string().optional().describe("MC version (default 26.1.2)"),
        namespace: z.string().optional().describe("Tag namespace to search (default minecraft)"),
    },
    async ({ entry, registry, version, namespace }) => {
        const result = await findTagsForEntry(entry, registry, version, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_recipes",
    "List vanilla MC recipes. Without filters returns all recipe IDs. With type/outputItem filters, loads and searches each recipe (results cached).",
    {
        version:    z.string().optional().describe("MC version (default 26.1.2)"),
        type:       z.string().optional().describe("Recipe type substring: 'crafting_shaped', 'smelting', 'smithing', 'blasting', 'stonecutting'"),
        outputItem: z.string().optional().describe("Output item substring to filter by, e.g. 'iron_ingot'"),
    },
    async ({ version, type, outputItem }) => {
        const result = await listRecipes(version, type, outputItem);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_recipe",
    "Get the full JSON for a specific vanilla recipe by its ID (e.g. 'crafting_table', 'iron_ingot_from_nuggets').",
    {
        recipeId: z.string().describe("Recipe ID, e.g. 'crafting_table' or 'minecraft:iron_ingot_from_nuggets'"),
        version:  z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ recipeId, version }) => {
        const result = await getRecipe(version, recipeId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_loot_tables",
    "List vanilla loot tables. Without category returns top-level categories (blocks, entities, chests, gameplay). With category lists all tables in it.",
    {
        version:  z.string().optional().describe("MC version (default 26.1.2)"),
        category: z.string().optional().describe("Category: blocks | entities | chests | gameplay | equipment | …"),
    },
    async ({ version, category }) => {
        const result = await listLootTables(version, category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_loot_table",
    "Get the full JSON for a specific vanilla loot table. path examples: 'blocks/iron_ore', 'chests/dungeon', 'entities/creeper'.",
    {
        path:    z.string().describe("Loot table path, e.g. 'blocks/iron_ore' or 'chests/dungeon'"),
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ path, version }) => {
        const result = await getLootTable(version, path);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_lang_entries",
    "Search vanilla en_us.json translation keys and values. Returns key→value pairs matching the filter substring. Useful for finding translationKey strings for items, entities, effects.",
    {
        version: z.string().optional().describe("MC version (default 26.1.2)"),
        filter:  z.string().optional().describe("Substring to match against key or value (case-insensitive)"),
        limit:   z.number().optional().describe("Max entries to return (default 100)"),
    },
    async ({ version, filter, limit }) => {
        const result = await getLangEntries(version, filter, limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_blockstate",
    "Get the blockstate JSON for a vanilla block — shows all variant definitions and the model path each maps to.",
    {
        block:   z.string().describe("Block ID, e.g. 'stone', 'oak_door', 'minecraft:grass_block'"),
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ block, version }) => {
        const result = await getBlockstate(version, block);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_model",
    "Get a vanilla model JSON and its resolved parent chain with merged texture keys. modelPath: e.g. 'block/stone', 'item/iron_sword', 'block/cube_all'.",
    {
        modelPath:      z.string().describe("Model path, e.g. 'block/stone', 'item/diamond_sword'"),
        version:        z.string().optional().describe("MC version (default 26.1.2)"),
        resolveParents: z.boolean().optional().describe("Follow parent chain and merge textures (default true)"),
    },
    async ({ modelPath, version, resolveParents }) => {
        const result = await getMcModel(version, modelPath, resolveParents);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_biomes",
    "List all vanilla biomes for a MC version (from the worldgen/biome data pack directory).",
    {
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ version }) => {
        const result = await listBiomes(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_biome",
    "Get the full worldgen biome JSON for a specific vanilla biome (spawners, features, climate data).",
    {
        biomeId: z.string().describe("Biome ID, e.g. 'minecraft:desert', 'deep_dark', 'windswept_hills'"),
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ biomeId, version }) => {
        const result = await getBiome(version, biomeId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_damage_types",
    "List all vanilla damage types with full JSON definitions: message_id, scaling, exhaustion, effects, death_message_type.",
    {
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ version }) => {
        const result = await listDamageTypes(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_enchantments",
    "List all vanilla enchantments for a MC version.",
    {
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ version }) => {
        const result = await listEnchantments(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_enchantment",
    "Get the full JSON definition of a vanilla enchantment (effects, slots, supported items, exclusions, max level).",
    {
        id:      z.string().describe("Enchantment ID, e.g. 'minecraft:sharpness', 'looting', 'protection'"),
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ id, version }) => {
        const result = await getEnchantment(version, id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_advancements",
    "List vanilla advancements. Without category returns tabs (story, nether, end, adventure, husbandry). With category lists all advancements in it.",
    {
        version:  z.string().optional().describe("MC version (default 26.1.2)"),
        category: z.string().optional().describe("Tab: story | nether | end | adventure | husbandry"),
    },
    async ({ version, category }) => {
        const result = await listAdvancements(version, category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_advancement",
    "Get the full JSON for a specific vanilla advancement. id: e.g. 'story/mine_stone', 'nether/root', 'adventure/kill_a_mob'.",
    {
        id:      z.string().describe("Advancement path, e.g. 'story/mine_stone' or 'nether/all_effects'"),
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ id, version }) => {
        const result = await getAdvancement(version, id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "find_recipes_for_item",
    "Find all vanilla recipes whose output contains a given item. Reverse lookup from item → recipes.",
    {
        item:    z.string().describe("Item id, e.g. 'iron_ingot' or 'minecraft:iron_ingot'"),
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ item, version }) => {
        const result = await findRecipesForItem(item, version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_model_tree",
    "Resolve the full block/item model inheritance chain, following 'parent' references until a builtin or root model is reached. Returns each model's JSON plus merged texture map.",
    {
        modelPath: z.string().describe("Model path, e.g. 'block/stone', 'item/diamond_sword'"),
        version:   z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ modelPath, version }) => {
        const result = await getModelTree(modelPath, version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_structures",
    "List all vanilla worldgen structures (data/minecraft/worldgen/structure/*.json).",
    {
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ version }) => {
        const result = await listStructures(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_structure_data",
    "Get the full JSON for a vanilla worldgen structure. id: e.g. 'minecraft:village_plains', 'bastion_remnant'.",
    {
        id:      z.string().describe("Structure id, e.g. 'village_plains' or 'minecraft:bastion_remnant'"),
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ id, version }) => {
        const result = await getStructureData(id, version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mc_particles",
    "List all vanilla particle types. Returns particle ids from the assets/minecraft/particles/ directory.",
    {
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ version }) => {
        const result = await getMcParticles(version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_particle_data",
    "Get the description JSON for a specific vanilla particle type. id: e.g. 'dust', 'explosion'.",
    {
        id:      z.string().describe("Particle id, e.g. 'dust' or 'minecraft:dust'"),
        version: z.string().optional().describe("MC version (default 26.1.2)"),
    },
    async ({ id, version }) => {
        const result = await getParticleData(id, version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_entity_attributes",
    "Get default attributes for a vanilla or modded entity. Vanilla: reads mcmeta data pack or built-in defaults table. Modded: searches decompiled source for createAttributes() — requires mod to be decompiled first.",
    {
        entity:  z.string().optional().describe("Entity id — 'player', 'zombie', 'mymod:my_creature'. Omit to list all vanilla attribute files."),
        version: z.string().optional().describe("MC version (default 26.1.2, for vanilla lookups)"),
        modId:   z.union([z.string(), z.number()]).optional().describe("Mod ID or numeric DB id for modded entity attribute lookup"),
    },
    async ({ entity, version, modId }) => {
        const result = await getEntityAttributes(entity, version, modId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_registry_entries",
    "List entities, items, blocks, enchantments, or effects registered by a mod. Reads the mod's en_us.json lang file from the JAR — works without decompilation. type: 'item' | 'block' | 'entity_type' | 'enchantment' | 'effect' | 'biome' | 'all'.",
    {
        modId:  z.union([z.string(), z.number()]).describe("Mod ID string (e.g. 'mythicmounts') or numeric DB id"),
        type:   z.enum(["item", "block", "entity_type", "enchantment", "effect", "biome", "all"]).optional().describe("Registry type to filter (default 'all')"),
        filter: z.string().optional().describe("Optional name/display filter substring"),
        limit:  z.number().optional().describe("Max entries returned (default 200)"),
    },
    async ({ modId, type, filter, limit }) => {
        const result = await listModRegistryEntries(modId, type as "item" | "block" | "entity_type" | "enchantment" | "effect" | "biome" | "all", filter, limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "find_implementors",
    "Find all mod classes in the DB that extend or implement a given class or interface. Requires reindex_classes to have run.",
    {
        target: z.string().describe("Class name (slash or dot notation), e.g. 'net/minecraft/world/entity/Entity' or 'net.neoforged.neoforge.common.extensions.IEntityExtension'"),
        modId:  z.union([z.string(), z.number()]).optional().describe("Limit to a specific mod (id or numeric DB id)"),
        limit:  z.number().optional().describe("Max results per category (default 100)"),
    },
    async ({ target, modId, limit }) => {
        const result = await findImplementors(target, modId, limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "search_events",
    "Search decompiled Minecraft source for Event subclasses. Requires decompile_minecraft_version to have run first.",
    {
        version:    z.string().describe("MC version, e.g. '26.1.2'"),
        query:      z.string().optional().describe("Optional name filter, e.g. 'Living', 'Player', 'Block'"),
        modloader:  z.enum(["minecraft", "neoforge"]).optional().describe("Source to search (default 'minecraft')"),
    },
    async ({ version, query, modloader }) => {
        const result = await searchEvents(version, query, modloader as "minecraft" | "neoforge" | undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Mod tag indexing + cross-mod tag queries ───────────────────────────────────

server.tool(
    "index_mod_tags",
    "Scan a mod JAR and index all its data/<ns>/tags/<registry>/... JSON files into the mod_tags table. Safe to re-run — replaces existing entries.",
    {
        modId: z.union([z.string(), z.number()]).describe("Mod ID string or DB integer id"),
    },
    async ({ modId }) => {
        const result = await indexModTags(modId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "index_all_mod_tags",
    "Scan and index tag files for ALL ingested mods. Returns a per-mod summary of how many tag entries were indexed.",
    {},
    async () => {
        const result = await indexAllModTags();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_tag_namespaces",
    "List all tag namespaces and registries present across all indexed mods (e.g. 'c', 'forge', 'minecraft', 'mymod' under 'block', 'item', etc.).",
    {},
    async () => {
        const result = await listTagNamespaces();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_tag_contributors",
    "Show every mod that contributes to a specific tag path (e.g. 'c:ores/iron', 'forge:storage_blocks'). Highlights replace:true conflicts.",
    {
        tagPath:  z.string().describe("Tag path, e.g. 'c:ores/iron' or '#forge:storage_blocks'"),
        registry: z.string().optional().describe("Registry hint: block | item | entity_type | fluid | …"),
    },
    async ({ tagPath, registry }) => {
        const result = await getTagContributors(tagPath, registry);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_tag_list",
    "List all tags registered by a specific mod, grouped by registry.",
    {
        modId:    z.union([z.string(), z.number()]).describe("Mod ID string or DB integer id"),
        registry: z.string().optional().describe("Filter by registry: block | item | entity_type | …"),
    },
    async ({ modId, registry }) => {
        const result = await getModTagList(modId, registry);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "find_tag_conflicts",
    "Find tag conflicts across all indexed mods. Hard conflicts: multiple mods set replace:true on the same tag. Soft conflicts: one mod silences others' entries with replace:true.",
    {
        registry: z.string().optional().describe("Limit to one registry: block | item | entity_type | …"),
    },
    async ({ registry }) => {
        const result = await findTagConflicts(registry);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "search_mod_tags",
    "Search tag paths across all indexed mods by substring. Returns grouped results showing all contributors per tag.",
    {
        query:    z.string().describe("Substring to match in tag paths, e.g. 'ores', 'storage', 'logs'"),
        registry: z.string().optional().describe("Limit to one registry"),
        limit:    z.number().optional().describe("Max results (default 50)"),
    },
    async ({ query, registry, limit }) => {
        const result = await searchModTags(query, registry, limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Cross-mod mixin analysis ───────────────────────────────────────────────────

server.tool(
    "list_mods_with_mixins",
    "List all ingested mods that have mixins, with their resolved target classes. Filter by loader or MC version.",
    {
        loader:    z.string().optional().describe("fabric | neoforge | forge | quilt"),
        mcVersion: z.string().optional().describe("MC version substring filter"),
    },
    async ({ loader, mcVersion }) => {
        const result = await listModsWithMixins(loader, mcVersion);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mixin_conflict_matrix",
    "Full cross-mod mixin conflict matrix: every class targeted by 2+ mods, with all mods listed. Includes hotspot summary.",
    {
        loader:       z.string().optional().describe("fabric | neoforge | forge | quilt"),
        mcVersion:    z.string().optional().describe("MC version substring filter"),
        minConflicts: z.number().optional().describe("Min number of mods to count as a conflict (default 2)"),
    },
    async ({ loader, mcVersion, minConflicts }) => {
        const result = await getMixinConflictMatrix(loader, mcVersion, minConflicts);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mixin_class_detail",
    "Show every mod that mixes into a specific class, with loader and MC version context.",
    {
        targetClass: z.string().describe("Fully-qualified class name, e.g. 'net/minecraft/world/entity/player/Player'"),
    },
    async ({ targetClass }) => {
        const result = await getMixinClassDetail(targetClass);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mixin_hotspots",
    "Top-N most contested classes by number of mods targeting them.",
    {
        top:    z.number().optional().describe("How many to return (default 20)"),
        loader: z.string().optional().describe("fabric | neoforge | forge | quilt"),
    },
    async ({ top, loader }) => {
        const result = await getMixinHotspots(top, loader);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Gradle build file tools ────────────────────────────────────────────────────

server.tool(
    "get_mod_gradle_files",
    "Get parsed build.gradle / build.gradle.kts files for a mod's source directory, including extracted dependencies, plugins, and repository URLs.",
    {
        modId: z.union([z.string(), z.number()]).describe("Mod ID string or DB integer id"),
    },
    async ({ modId }) => {
        const result = await getModGradleFiles(modId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "search_gradle_files",
    "Search gradle build files across all mods for a pattern. Returns matching lines with surrounding context.",
    {
        query:       z.string().describe("Text to search for, e.g. 'jarJar', 'cursemaven', 'modrinth', a group:artifact"),
        modIdFilter: z.string().optional().describe("Limit search to mods whose ID contains this string"),
        limit:       z.number().optional().describe("Max results (default 20)"),
    },
    async ({ query, modIdFilter, limit }) => {
        const result = await searchGradleFiles(query, modIdFilter, limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "compare_gradle_deps",
    "Compare gradle dependencies across all mods. Find who uses the same library, who uses conflicting versions, who embeds vs. compileOnly.",
    {
        groupFilter: z.string().optional().describe("Filter by group:artifact substring, e.g. 'curse.maven', 'net.minecraftforge'"),
        modIdFilter: z.string().optional().describe("Limit to mods whose ID contains this string"),
    },
    async ({ groupFilter, modIdFilter }) => {
        const result = await compareGradleDeps(groupFilter, modIdFilter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Dependency graph + version conflict tools ──────────────────────────────────

server.tool(
    "find_version_conflicts",
    "Detect version conflicts: multiple ingested versions of the same modId, and dependency version ranges that may not be satisfied by ingested mods.",
    {},
    async () => {
        const result = await findVersionConflicts();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_dependency_graph",
    "Build a full dependency graph across all ingested mods: for each mod, what it requires and what requires it. Includes source URLs.",
    {
        mcVersion: z.string().optional().describe("Filter to a specific MC version substring"),
    },
    async ({ mcVersion }) => {
        const result = await getDependencyGraph(mcVersion);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_source_urls",
    "Show source URLs (GitHub, GitLab, etc.) for all ingested mods, extracted from their JAR manifests at ingest time.",
    {
        query: z.string().optional().describe("Filter by mod ID or display name substring"),
    },
    async ({ query }) => {
        const result = await listModSourceUrls(query);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Mod JAR data/asset file access (parity with vanilla data tools) ───────────

server.tool(
    "list_mod_jar_files",
    "List all files inside a mod JAR under an optional path prefix. Useful for exploring what data pack / resource pack content a mod ships.",
    {
        modId:  z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        prefix: z.string().optional().describe("Path prefix to scope listing, e.g. 'data/mymod/', 'assets/mymod/blockstates/'"),
    },
    async ({ modId, prefix }) => {
        const result = await listModJarFiles(modId, prefix);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_jar_file",
    "Read any file from a mod JAR by its internal path. Returns parsed JSON for .json files, raw text otherwise.",
    {
        modId: z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        path:  z.string().describe("Internal JAR path, e.g. 'data/mymod/recipe/iron_sword.json'"),
    },
    async ({ modId, path }) => {
        const result = await getModJarFile(modId, path);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_recipes",
    "List all recipes a mod ships in its JAR (data/<ns>/recipe/). Returns namespace:id pairs.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search (default: mod's own namespace)"),
        filter:    z.string().optional().describe("Substring filter on recipe path"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModRecipes(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_recipe",
    "Get the full JSON for a specific mod recipe. id: e.g. 'mymod:iron_sword' or just 'iron_sword'.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        id:        z.string().describe("Recipe id, e.g. 'mymod:iron_sword' or 'iron_sword'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, id, namespace }) => {
        const result = await getModRecipe(modId, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_loot_tables",
    "List all loot tables a mod ships in its JAR.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModLootTables(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_loot_table",
    "Get the full JSON for a specific mod loot table.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        id:        z.string().describe("Loot table id, e.g. 'mymod:entities/my_mob'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, id, namespace }) => {
        const result = await getModLootTable(modId, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_advancements",
    "List all advancements a mod ships in its JAR.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModAdvancements(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_advancement",
    "Get the full JSON for a specific mod advancement.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        id:        z.string().describe("Advancement id, e.g. 'mymod:my_advancement'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, id, namespace }) => {
        const result = await getModAdvancement(modId, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_blockstates",
    "List all blockstate files a mod ships (assets/<ns>/blockstates/).",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModBlockstates(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_blockstate",
    "Get the blockstate JSON for a mod block — shows variant definitions and model path mappings.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        block:     z.string().describe("Block id, e.g. 'mymod:my_block' or just 'my_block'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, block, namespace }) => {
        const result = await getModBlockstate(modId, block, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_models",
    "List all model JSON files a mod ships (assets/<ns>/models/).",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter, e.g. 'block/' or 'item/'"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModModels(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_model",
    "Get a model JSON from a mod JAR. modelPath: e.g. 'block/my_block', 'item/my_item', or 'mymod:block/my_block'.",
    {
        modId:      z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        modelPath:  z.string().describe("Model path, e.g. 'block/my_block' or 'mymod:item/my_item'"),
        namespace:  z.string().optional().describe("Namespace override"),
    },
    async ({ modId, modelPath, namespace }) => {
        const result = await getModModel(modId, modelPath, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_biomes",
    "List all worldgen biomes a mod ships (data/<ns>/worldgen/biome/).",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModBiomes(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_biome",
    "Get the full JSON for a mod worldgen biome.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        id:        z.string().describe("Biome id, e.g. 'mymod:my_biome'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, id, namespace }) => {
        const result = await getModBiome(modId, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_structures",
    "List all worldgen structures a mod ships (data/<ns>/worldgen/structure/).",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModStructures(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_structure_data",
    "Get the full JSON for a mod worldgen structure.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        id:        z.string().describe("Structure id, e.g. 'mymod:my_dungeon'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, id, namespace }) => {
        const result = await getModStructureData(modId, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_lang",
    "Get translation strings from a mod's en_us.json. Supports substring filter on key or value.",
    {
        modId:  z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        filter: z.string().optional().describe("Substring filter on key or translated value"),
        limit:  z.number().optional().describe("Max entries returned (default 200)"),
    },
    async ({ modId, filter, limit }) => {
        const result = await getModLang(modId, filter, limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_sounds",
    "Get the sounds.json for a mod — lists all registered sound events and their file mappings.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, namespace }) => {
        const result = await getModSounds(modId, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_data_tags",
    "List data-pack tag files shipped by a mod (data/<ns>/tags/). Filter by registry (item/block/entity_type/etc.) and/or substring.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        registry:  z.string().optional().describe("Tag registry folder, e.g. 'item', 'block', 'entity_type'"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter on tag path"),
    },
    async ({ modId, registry, namespace, filter }) => {
        const result = await listModDataTags(modId, registry, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_data_tag",
    "Get the entries JSON for a specific data-pack tag from a mod JAR.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        registry:  z.string().describe("Tag registry, e.g. 'item', 'block', 'entity_type'"),
        id:        z.string().describe("Tag id, e.g. 'mymod:my_tag'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, registry, id, namespace }) => {
        const result = await getModDataTag(modId, registry, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_particles",
    "List all particle description files a mod ships (assets/<ns>/particles/).",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModParticles(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_particle",
    "Get the description JSON for a specific mod particle type.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        id:        z.string().describe("Particle id, e.g. 'mymod:my_particle'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, id, namespace }) => {
        const result = await getModParticle(modId, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_damage_types",
    "List all damage type data files a mod ships (data/<ns>/damage_type/).",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModDamageTypes(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_damage_type",
    "Get the full JSON for a mod damage type.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        id:        z.string().describe("Damage type id, e.g. 'mymod:my_damage'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, id, namespace }) => {
        const result = await getModDamageType(modId, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_atlas",
    "Get a texture atlas JSON from a mod JAR (assets/<ns>/atlases/<atlas>.json).",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        atlas:     z.string().optional().describe("Atlas name, e.g. 'blocks' (default), 'armor_trims'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, atlas, namespace }) => {
        const result = await getModAtlas(modId, atlas, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "list_mod_enchantments",
    "List enchantment data files a mod ships (data/<ns>/enchantment/). Note: older mods register enchantments in code — use list_mod_registry_entries with type='enchantment' as a fallback.",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        namespace: z.string().optional().describe("Namespace to scope search"),
        filter:    z.string().optional().describe("Substring filter"),
    },
    async ({ modId, namespace, filter }) => {
        const result = await listModEnchantments(modId, namespace, filter);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "get_mod_enchantment",
    "Get the full JSON for a mod enchantment data file (1.21+ data-driven enchantments).",
    {
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        id:        z.string().describe("Enchantment id, e.g. 'mymod:my_enchant'"),
        namespace: z.string().optional().describe("Namespace override"),
    },
    async ({ modId, id, namespace }) => {
        const result = await getModEnchantment(modId, id, namespace);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Markdown report generator ─────────────────────────────────────────────────

server.tool(
    "generate_report",
    "Generate a human-readable Markdown report from modlens data. Optionally save to a file. Reports: mixin_conflicts | tag_conflicts | version_conflicts | mod_overview | gradle_deps.",
    {
        report:      z.enum(["mixin_conflicts", "tag_conflicts", "version_conflicts", "mod_overview", "gradle_deps"]).describe("Which report to generate"),
        savePath:    z.string().optional().describe("Absolute path to save the .md file, e.g. 'C:/reports/mixin_conflicts.md'"),
        modId:       z.union([z.string(), z.number()]).optional().describe("Required for mod_overview report"),
        loader:      z.string().optional().describe("Loader filter for mixin_conflicts"),
        mcVersion:   z.string().optional().describe("MC version filter for mixin_conflicts"),
        registry:    z.string().optional().describe("Registry filter for tag_conflicts"),
        minConflicts: z.number().optional().describe("Min mods for mixin conflict (default 2)"),
        groupFilter: z.string().optional().describe("Dep group filter for gradle_deps"),
        modIdFilter: z.string().optional().describe("Mod filter for gradle_deps"),
    },
    async ({ report, savePath, modId, loader, mcVersion, registry, minConflicts, groupFilter, modIdFilter }) => {
        const result = await generateReport({ report, savePath, modId, loader, mcVersion, registry, minConflicts, groupFilter, modIdFilter });
        return { content: [{ type: "text", text: result.savedTo ? `Saved to: ${result.savedTo}\n\n${result.markdown}` : result.markdown }] };
    }
);

server.tool(
    "batch_resolve_mixins",
    "Resolve @Mixin bytecode annotations for every hasMixins=true mod in the DB and update mixinTargets. Run this after ingesting new mods or after fixing the mixin parser. Returns a per-mod status + totals.",
    {
        loader:    z.string().optional().describe("Limit to a specific loader: neoforge | fabric | forge"),
        mcVersion: z.string().optional().describe("Limit to mods whose mcVersion contains this string"),
    },
    async ({ loader, mcVersion }) => {
        const result = await batchResolveMixins(loader, mcVersion);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.tool(
    "batch_ingest",
    "Ingest all JAR files found in a directory. Skips already-ingested files. Returns per-file results plus totals (ingested / skipped / failed).",
    {
        directory:    z.string().describe("Absolute path to the directory containing JAR files"),
        skipSource:   z.boolean().optional().describe("Skip Modrinth/CurseForge source lookup (default true)"),
        indexClasses: z.boolean().optional().describe("Run class indexing immediately after each ingest (slower but thorough)"),
    },
    async ({ directory, skipSource, indexClasses }) => {
        const result = await batchIngest(directory, skipSource ?? true, indexClasses ?? false);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

// ── Start ─────────────────────────────────────────────────────────────────────

process.on("SIGINT", async () => { await disconnect(); process.exit(0); });
process.on("SIGTERM", async () => { await disconnect(); process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
