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
    listModGenericDataType, getModGenericDataType,
    getModManifest, listModConfigs, getModConfig,
    diffModData,
} from "./tools/mod-data.js";
import { traceRecipeChain } from "./tools/mod-data.js";
import { getModSource, searchSource, decompileModClass } from "./tools/source.js";
import {
    searchModClass, getModClassMembers, getModClassBytecode,
    findModReferences, getModInheritance, diffModVersions, findImplementors,
    scanModRegistrations, findAnnotatedClasses,
    crossModRefs, findEventListeners,
    findOptionalIntegrations, findNetworkPayloads, extractConfigSchema,
} from "./tools/bytecode.js";
import { getMixinTargets, getMixinConflicts, getAtEntries, getAwEntries, resolveMixinTargets, getMixinsTargetingPackage, findAtAwConflicts } from "./tools/mixins.js";
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
    getModTagList, findTagConflicts, searchModTags, expandTag,
} from "./tools/mod-tags.js";
import {
    listModsWithMixins, getMixinConflictMatrix, getMixinClassDetail, getMixinHotspots, batchResolveMixins,
} from "./tools/mixin-scan.js";
import {
    getModGradleFiles, searchGradleFiles, compareGradleDeps,
} from "./tools/gradle.js";
import { generateReport } from "./tools/reports.js";
import { findAssetConflicts, findVanillaOverrides, analyzeModSidedness, analyzePackSidedness, computeModComplexity, computePackChangelog, findDataConflicts } from "./tools/packtools.js";
import { indexKubeJsScripts, searchKubeJsScripts } from "./tools/kubejs.js";
import { analyzeCrashLog, findMissingDeps } from "./tools/diagnostics.js";
import { checkModCompat } from "./tools/compat-check.js";
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

/** Serialize any result to MCP text content. */
function out(result: unknown): { content: Array<{ type: "text"; text: string }> } {
    const text =
        typeof result === "string" ? result
        : Array.isArray(result) && result.every(x => typeof x === "string") ? (result as string[]).join("\n")
        : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
}

// ── 1. mod ────────────────────────────────────────────────────────────────────

server.tool(
    "mod",
    "Mod database, decompile, and source browser. " +
    "action=ingest: add JAR to DB (jarPath, skipSource). " +
    "action=list: list mods (loader, mcVersion, hasMixins, decompiled, limit). " +
    "action=get: get full metadata (modId). " +
    "action=search: search by name/description (query, loader, mcVersion, limit). " +
    "action=stats: DB statistics. " +
    "action=dependencies: dep list for a mod (modId, recursive). " +
    "action=dep_graph: full dependency graph (mcVersion). " +
    "action=version_conflicts: detect duplicate modIds / unsatisfied deps. " +
    "action=source_urls: show GitHub/GitLab URLs (query). " +
    "action=decompile: bulk decompile mod JAR via Vineflower — runs in background (dbId, force). " +
    "action=decompile_status: poll background decompile job (dbId). " +
    "action=decompile_class: decompile a single class on demand (dbId, className). " +
    "action=source: browse or read decompiled source tree (dbId, path). " +
    "action=search_source: text/regex search across decompiled source (query, dbId, isRegex, limit). " +
    "action=reindex: re-index class names (dbId optional). " +
    "action=batch_ingest: ingest all JARs in a directory (directory, skipSource, indexClasses, replace).",
    {
        action: z.enum([
            "ingest","list","get","search","stats","dependencies","dep_graph",
            "version_conflicts","source_urls","decompile","decompile_status",
            "decompile_class","source","search_source","reindex","batch_ingest",
        ]).describe("Operation to perform"),
        jarPath:      z.string().optional().describe("Absolute path to JAR (ingest)"),
        modId:        z.union([z.string(), z.number()]).optional().describe("Mod ID string or numeric DB id (get, dependencies, source_urls)"),
        dbId:         z.number().optional().describe("DB integer id (decompile, decompile_status, decompile_class, source, search_source, reindex)"),
        query:        z.string().optional().describe("Search query (search, search_source, source_urls)"),
        path:         z.string().optional().describe("Relative path within decompiled source (source)"),
        className:    z.string().optional().describe("Internal class name slashes/dots (decompile_class)"),
        loader:       z.string().optional().describe("fabric|neoforge|forge|quilt (list)"),
        mcVersion:    z.string().optional().describe("MC version substring (list, dep_graph)"),
        hasMixins:    z.boolean().optional().describe("Filter by mixin presence (list)"),
        decompiled:   z.boolean().optional().describe("Filter by decompile status (list)"),
        recursive:    z.boolean().optional().describe("Recursive dep resolution (dependencies)"),
        skipSource:   z.boolean().optional().describe("Skip platform lookup (ingest, batch_ingest)"),
        isRegex:      z.boolean().optional().describe("Treat query as regex (search_source)"),
        force:        z.boolean().optional().describe("Force re-decompile (decompile)"),
        limit:        z.number().optional().describe("Max results"),
        directory:    z.string().optional().describe("Directory of JARs (batch_ingest)"),
        indexClasses: z.boolean().optional().describe("Index classes during batch_ingest"),
        replace:      z.boolean().optional().describe("Replace existing mod with same modId (batch_ingest, ingest)"),
    },
    async ({ action, jarPath, modId, dbId, query, path, className, loader, mcVersion, hasMixins, decompiled, recursive, skipSource, isRegex, force, limit, directory, indexClasses, replace }) => {
        let result: unknown;
        switch (action) {
            case "ingest":           result = await ingestMod(jarPath!, skipSource ?? false, replace ?? false); break;
            case "list":             result = await listMods({ loader: loader as any, mcVersion, hasMixins, decompiled, limit: limit ?? 50 }); break;
            case "get":              result = await getModDetails(modId!); break;
            case "search":           result = await searchMods(query!, { loader, mcVersion, limit: limit ?? 20 }); break;
            case "stats":            result = await getDbStats(); break;
            case "dependencies":     result = await getDependencies(modId!, recursive ?? false); break;
            case "dep_graph":        result = await getDependencyGraph(mcVersion); break;
            case "version_conflicts":result = await findVersionConflicts(); break;
            case "source_urls":      result = await listModSourceUrls(query); break;
            case "decompile":        result = await decompileMod(dbId!); break;
            case "decompile_status": result = await decompileModStatus(dbId!); break;
            case "decompile_class":  result = await decompileModClass(dbId!, className!); break;
            case "source":           result = await getModSource(dbId!, path); break;
            case "search_source":    result = await searchSource(query!, dbId, isRegex ?? false, limit ?? 50); break;
            case "reindex":          result = await reindexClasses(dbId); break;
            case "batch_ingest":     result = await batchIngest(directory!, skipSource ?? true, indexClasses ?? false, replace ?? false); break;
        }
        return out(result);
    }
);

// ── 2. mod_bytecode ───────────────────────────────────────────────────────────

server.tool(
    "mod_bytecode",
    "Mod JAR bytecode and class analysis. " +
    "action=search_class: find class by name with CamelCase/prefix/substring matching (dbId, query). " +
    "action=class_members: list methods/fields with @Inject mixin targets, @Shadow, AT/AW strings (dbId, className). " +
    "action=bytecode: raw javap output (dbId, className). " +
    "action=find_refs: find all classes referencing a class/method/field within one mod JAR (dbId, target). " +
    "action=cross_refs: find which mods in the DB reference a given class/method/field — cross-mod coupling analysis (target, mcVersion, loader, limit). " +
    "action=inheritance: superclass, interfaces, subclasses, implementors (dbId, className). " +
    "action=diff: added/removed classes between two mod versions (dbIdA, dbIdB). " +
    "action=find_implementors: find mod classes across DB that extend/implement a target (target, modId, limit, transitive). Set transitive=true to walk the full inheritance chain. " +
    "action=scan_registrations: scan all classes for registration patterns — DeferredRegister, @SubscribeEvent, commands, keybindings, network payloads, config builders, capabilities, loot modifiers (dbId). " +
    "action=annotated_by: find all classes across the DB annotated with a given annotation (annotation, modId, limit). Works without decompilation. " +
    "action=event_listeners: find @SubscribeEvent methods listening to a specific event class across the DB (event, modId, limit). " +
    "action=optional_integrations: detect which optional/conditional mod integrations a mod includes (JEI, Jade, REI, Curios, etc.) via bytecode reference analysis (dbId). " +
    "action=network_payloads: inventory all network packet/payload classes a mod ships — CustomPacketPayload implementors, StreamCodec types, channel registrations (dbId). " +
    "action=config_schema: extract config key schema from ModConfigSpec/ForgeConfigSpec/ClothConfig builder classes (dbId).",
    {
        action:     z.enum(["search_class","class_members","bytecode","find_refs","cross_refs","inheritance","diff","find_implementors","scan_registrations","annotated_by","event_listeners","optional_integrations","network_payloads","config_schema"]).describe("Operation to perform"),
        dbId:      z.number().optional().describe("DB id of mod (most actions)"),
        dbIdA:     z.number().optional().describe("Older mod DB id (diff)"),
        dbIdB:     z.number().optional().describe("Newer mod DB id (diff)"),
        query:     z.string().optional().describe("Class name query (search_class)"),
        className: z.string().optional().describe("Internal class name slashes/dots (class_members, bytecode, inheritance)"),
        target:    z.string().optional().describe("Class/method/field reference (find_refs, cross_refs, find_implementors). Format: 'com/example/MyClass' or 'com/example/MyClass:myMethod:(I)V'"),
        annotation:z.string().optional().describe("Annotation class name, slash or dot form (annotated_by), e.g. 'net/neoforged/bus/api/SubscribeEvent'"),
        event:     z.string().optional().describe("Event class name, slash or dot form (event_listeners), e.g. 'net/neoforged/neoforge/event/entity/living/LivingDeathEvent'"),
        modId:     z.union([z.string(), z.number()]).optional().describe("Limit find_implementors / annotated_by / event_listeners to a specific mod"),
        transitive:z.boolean().optional().describe("Walk full inheritance chain (find_implementors, default false)"),
        mcVersion: z.string().optional().describe("Filter by MC version (cross_refs)"),
        loader:    z.string().optional().describe("Filter by loader (cross_refs)"),
        limit:     z.number().optional().describe("Max results (find_implementors, annotated_by, cross_refs, event_listeners)"),
    },
    async ({ action, dbId, dbIdA, dbIdB, query, className, target, annotation, event, modId, transitive, mcVersion, loader, limit }) => {
        let result: unknown;
        switch (action) {
            case "search_class":     result = await searchModClass(dbId!, query!); break;
            case "class_members":    result = await getModClassMembers(dbId!, className!); break;
            case "bytecode":         result = await getModClassBytecode(dbId!, className!); break;
            case "find_refs":        result = await findModReferences(dbId!, target!); break;
            case "cross_refs":       result = await crossModRefs(target!, mcVersion, loader, limit); break;
            case "inheritance":      result = await getModInheritance(dbId!, className!); break;
            case "diff":             result = await diffModVersions(dbIdA!, dbIdB!); break;
            case "find_implementors":result = await findImplementors(target!, modId, limit, transitive); break;
            case "scan_registrations": result = await scanModRegistrations(dbId!); break;
            case "annotated_by":     result = await findAnnotatedClasses(annotation!, modId, limit); break;
            case "event_listeners":  result = await findEventListeners(event!, modId, limit); break;
            case "optional_integrations": result = await findOptionalIntegrations(dbId!); break;
            case "network_payloads": result = await findNetworkPayloads(dbId!); break;
            case "config_schema":    result = await extractConfigSchema(dbId!); break;
        }
        return out(result);
    }
);

// ── 3. mod_mixins ─────────────────────────────────────────────────────────────

server.tool(
    "mod_mixins",
    "Mod mixin and access transformer analysis. " +
    "action=targets: list Minecraft classes a mod injects into via @Mixin (modId). " +
    "action=resolve: read @Mixin bytecode annotations to discover actual target classes and update DB (dbId). " +
    "action=conflicts: find all mods in DB injecting into the same MC class (targetClass). " +
    "action=targets_in_package: find all mods whose mixin targets fall under a given package prefix (packagePrefix, mcVersion optional). " +
    "action=at_conflicts: find AT/AW entries shared by multiple mods, highlighting access-level disagreements (mcVersion, loader optional). " +
    "action=at_entries: NeoForge/Forge Access Transformer entries for a mod (dbId). " +
    "action=aw_entries: Fabric/Quilt Access Widener entries for a mod (dbId).",
    {
        action:        z.enum(["targets","resolve","conflicts","targets_in_package","at_conflicts","at_entries","aw_entries"]).describe("Operation to perform"),
        modId:         z.union([z.string(), z.number()]).optional().describe("Mod ID string or DB id (targets)"),
        dbId:          z.number().optional().describe("DB integer id (resolve, at_entries, aw_entries)"),
        targetClass:   z.string().optional().describe("Internal class name (conflicts), e.g. 'net/minecraft/world/entity/LivingEntity'"),
        packagePrefix: z.string().optional().describe("Package prefix for targets_in_package, slash or dot form, e.g. 'net/minecraft/world/level' or 'net.minecraft.world.entity'"),
        mcVersion:     z.string().optional().describe("Filter by MC version (targets_in_package, at_conflicts)"),
        loader:        z.string().optional().describe("Filter by loader (at_conflicts)"),
    },
    async ({ action, modId, dbId, targetClass, packagePrefix, mcVersion, loader }) => {
        let result: unknown;
        switch (action) {
            case "targets":            result = await getMixinTargets(modId!); break;
            case "resolve":            result = await resolveMixinTargets(dbId!); break;
            case "conflicts":          result = await getMixinConflicts(targetClass!); break;
            case "targets_in_package": result = await getMixinsTargetingPackage(packagePrefix!, mcVersion); break;
            case "at_conflicts":       result = await findAtAwConflicts(mcVersion, loader); break;
            case "at_entries":         result = await getAtEntries(dbId!); break;
            case "aw_entries":         result = await getAwEntries(dbId!); break;
        }
        return out(result);
    }
);

// ── 4. platform ───────────────────────────────────────────────────────────────

server.tool(
    "platform",
    "Modrinth/CurseForge platform sync and source download. " +
    "action=sync_modrinth: SHA-512 lookup on Modrinth (dbId). " +
    "action=sync_curseforge: Murmur2 fingerprint lookup on CurseForge (dbId). " +
    "action=check_updates: check both platforms for newer version (dbId). " +
    "action=batch_sync: run lookups for all unmatched mods (syncModrinth, syncCurseforge, downloadSources, modIdFilter, limit). " +
    "action=download_source: download GitHub/GitLab source for a mod (dbId).",
    {
        action:          z.enum(["sync_modrinth","sync_curseforge","check_updates","batch_sync","download_source"]).describe("Operation to perform"),
        dbId:            z.number().optional().describe("DB id (sync_modrinth, sync_curseforge, check_updates, download_source)"),
        syncModrinth:    z.boolean().optional().describe("Run Modrinth lookup in batch_sync (default true)"),
        syncCurseforge:  z.boolean().optional().describe("Run CurseForge lookup in batch_sync (default true)"),
        downloadSources: z.boolean().optional().describe("Also download source ZIPs in batch_sync (default false)"),
        modIdFilter:     z.string().optional().describe("Limit batch_sync to mods whose modId contains this string"),
        limit:           z.number().optional().describe("Max mods to process in batch_sync (default 500)"),
    },
    async ({ action, dbId, syncModrinth: sm, syncCurseforge: sc, downloadSources, modIdFilter, limit }) => {
        let result: unknown;
        switch (action) {
            case "sync_modrinth":   result = await syncModrinth(dbId!); break;
            case "sync_curseforge": result = await syncCurseforge(dbId!); break;
            case "check_updates":   result = await checkUpdates(dbId!); break;
            case "batch_sync":      result = await batchSyncSources({ syncModrinth: sm, syncCurseforge: sc, downloadSources, modIdFilter, limit }); break;
            case "download_source": { const dir = await downloadSource(dbId!); result = `Source downloaded to: ${dir}`; break; }
        }
        return out(result);
    }
);

// ── 5. mc_versions ────────────────────────────────────────────────────────────

server.tool(
    "mc_versions",
    "Minecraft and mod loader version management. " +
    "action=list_mc: list MC versions from Mojang Piston Meta (type=release|snapshot|all). " +
    "action=list_neoforge: list NeoForge loader versions from Maven (mcVersion, limit). " +
    "action=list_fabric: list Fabric API versions from Modrinth (mcVersion, limit). " +
    "action=ingest_neoforge: download NeoForge universal JAR and ingest into DB (version, skipIndex). " +
    "action=ingest_fabric: download Fabric API JAR and ingest into DB (version, skipIndex).",
    {
        action:    z.enum(["list_mc","list_neoforge","list_fabric","ingest_neoforge","ingest_fabric"]).describe("Operation to perform"),
        type:      z.enum(["release","snapshot","all"]).optional().describe("Version filter for list_mc (default release)"),
        mcVersion: z.string().optional().describe("MC version filter for list_neoforge / list_fabric, e.g. '1.21.1'"),
        version:   z.string().optional().describe("Loader version string for ingest_neoforge (e.g. '21.1.228') or ingest_fabric (e.g. '0.116.11+1.21.1')"),
        skipIndex: z.boolean().optional().describe("Skip class indexing after ingest (faster but search won't work until reindex run)"),
        limit:     z.number().optional().describe("Max results for list commands (default 20)"),
    },
    async ({ action, type, mcVersion, version, skipIndex, limit }) => {
        let result: unknown;
        switch (action) {
            case "list_mc":      result = await listMcVersions(type ?? "release"); break;
            case "list_neoforge":result = await listNeoForgeVersions(mcVersion, limit ?? 20); break;
            case "list_fabric":  result = await listFabricApiVersions(mcVersion, limit ?? 20); break;
            case "ingest_neoforge": {
                const jarPath = await downloadNeoForge(version!);
                const r = await ingestMod(jarPath, true) as any;
                if (r.status === "already_ingested") { result = `Already ingested. DB id: ${r.mod.id}`; break; }
                if (!skipIndex) await reindexClasses(r.mod.id);
                result = { ...r, jarPath };
                break;
            }
            case "ingest_fabric": {
                const jarPath = await downloadFabricApi(version!);
                const r = await ingestMod(jarPath, true) as any;
                if (r.status === "already_ingested") { result = `Already ingested. DB id: ${r.mod.id}`; break; }
                if (!skipIndex) await reindexClasses(r.mod.id);
                result = { ...r, jarPath };
                break;
            }
        }
        return out(result);
    }
);

// ── 6. mc_source ─────────────────────────────────────────────────────────────

server.tool(
    "mc_source",
    "Vanilla Minecraft source code analysis, decompilation, and validation. " +
    "action=search_class: find class by name (version, query). " +
    "action=get_source: read decompiled source (version, className, startLine, endLine, maxLines). " +
    "action=bytecode: raw javap output (version, className). " +
    "action=class_members: list methods/fields with mixin target strings (version, className). " +
    "action=find_refs: find classes referencing a target (version, target). " +
    "action=inheritance: superclass/interfaces/subclasses (version, className). " +
    "action=diff: added/removed classes between two MC versions (versionA, versionB). " +
    "action=decompile: bulk decompile entire MC JAR via Vineflower — runs in background (version, force). " +
    "action=decompile_status: poll bulk decompile job (version). " +
    "action=search_code: regex/text search across decompiled MC source (version, query, searchType, isRegex, limit). " +
    "action=index: index decompiled MC into PostgreSQL FTS (version, force). " +
    "action=search_indexed: fast FTS search (version, query, limit). " +
    "action=search_events: find Event subclasses in decompiled source (version, query, modloader). " +
    "action=validate_aw: validate a Fabric Access Widener against MC JAR (content, mcVersion). " +
    "action=analyze_mixin: parse + validate a Mixin class source against MC (source, mcVersion).",
    {
        action:     z.enum(["search_class","get_source","bytecode","class_members","find_refs","inheritance","diff","decompile","decompile_status","search_code","index","search_indexed","search_events","validate_aw","analyze_mixin"]).describe("Operation to perform"),
        version:    z.string().optional().describe("MC version id, e.g. '26.1.2' (most actions)"),
        versionA:   z.string().optional().describe("Earlier MC version (diff)"),
        versionB:   z.string().optional().describe("Later MC version (diff)"),
        mcVersion:  z.string().optional().describe("MC version for validate_aw and analyze_mixin (falls back to version)"),
        query:      z.string().optional().describe("Search query (search_class, search_code, search_indexed, search_events)"),
        className:  z.string().optional().describe("Internal class name slashes/dots (get_source, bytecode, class_members, inheritance)"),
        target:     z.string().optional().describe("Class/method/field reference (find_refs)"),
        searchType: z.enum(["class","method","field","content","all"]).optional().describe("Search type for search_code (default content)"),
        isRegex:    z.boolean().optional().describe("Treat query as regex (search_code, default false)"),
        force:      z.boolean().optional().describe("Force re-decompile/re-index (decompile, index)"),
        modloader:  z.enum(["minecraft","neoforge"]).optional().describe("Source to search for search_events (default minecraft)"),
        content:    z.string().optional().describe("Full .accesswidener file text (validate_aw)"),
        source:     z.string().optional().describe("Full mixin Java source code (analyze_mixin)"),
        startLine:  z.number().optional().describe("First line to return, 1-based (get_source)"),
        endLine:    z.number().optional().describe("Last line to return, 1-based (get_source)"),
        maxLines:   z.number().optional().describe("Max lines to return when only startLine given (get_source)"),
        limit:      z.number().optional().describe("Max results"),
    },
    async ({ action, version, versionA, versionB, mcVersion, query, className, target, searchType, isRegex, force, modloader, content, source, startLine, endLine, maxLines, limit }) => {
        let result: unknown;
        switch (action) {
            case "search_class":    result = await searchMinecraftClass(version!, query!); break;
            case "get_source":      result = await getMinecraftSource(version!, className!, startLine, endLine, maxLines); break;
            case "bytecode":        result = await getMcClassBytecode(version!, className!); break;
            case "class_members":   result = await getMcClassMembers(version!, className!); break;
            case "find_refs":       result = await findMcReferences(version!, target!); break;
            case "inheritance":     result = await getMcInheritance(version!, className!); break;
            case "diff":            result = await diffMcVersions(versionA!, versionB!); break;
            case "decompile":       result = await decompileMcVersion(version!, force ?? false); break;
            case "decompile_status":result = await decompileMcVersionStatus(version!); break;
            case "search_code":     result = await searchMcCode(version!, query!, searchType ?? "content", isRegex ?? false, limit ?? 50); break;
            case "index":           result = await indexMcVersion(version!, force ?? false); break;
            case "search_indexed":  result = await searchMcIndexed(query!, version!, limit ?? 20); break;
            case "search_events":   result = await searchEvents(version!, query, modloader as any); break;
            case "validate_aw":     result = await validateAccessWidener(content!, mcVersion ?? version!); break;
            case "analyze_mixin":   result = await analyzeMixin(source!, mcVersion ?? version!); break;
        }
        return out(result);
    }
);

// ── 7. mappings ───────────────────────────────────────────────────────────────

server.tool(
    "mappings",
    "Minecraft name mappings and Parchment parameter documentation. " +
    "action=find: translate a symbol between namespaces official/intermediary/yarn/mojmap (symbol, version, sourceNs, targetNs). " +
    "action=remap: remap a mod JAR from official to yarn/mojmap using TinyRemapper (inputJar, outputJar, version, toMapping). " +
    "action=parchment: get community parameter names/javadocs for a class (className, mcVersion). " +
    "action=list_parchment: list available Parchment builds for a MC version (mcVersion). " +
    "action=parchment_summary: all classes with Parchment coverage for a MC version (mcVersion).",
    {
        action:    z.enum(["find","remap","parchment","list_parchment","parchment_summary"]).describe("Operation to perform"),
        symbol:    z.string().optional().describe("Symbol to translate, e.g. 'net/minecraft/world/entity/Entity' or 'tick' (find)"),
        version:   z.string().optional().describe("MC version (find, remap)"),
        sourceNs:  z.enum(["official","intermediary","yarn","mojmap"]).optional().describe("Source namespace (find)"),
        targetNs:  z.enum(["official","intermediary","yarn","mojmap"]).optional().describe("Target namespace (find)"),
        inputJar:  z.string().optional().describe("Absolute path to input JAR (remap)"),
        outputJar: z.string().optional().describe("Absolute path for remapped output JAR (remap)"),
        toMapping: z.enum(["yarn","mojmap"]).optional().describe("Target mapping namespace (remap)"),
        className: z.string().optional().describe("Class name slash/dot form (parchment), e.g. 'net/minecraft/world/entity/Entity'"),
        mcVersion: z.string().optional().describe("MC version (parchment, list_parchment, parchment_summary)"),
    },
    async ({ action, symbol, version, sourceNs, targetNs, inputJar, outputJar, toMapping, className, mcVersion }) => {
        let result: unknown;
        switch (action) {
            case "find":              result = await findMapping(symbol!, version!, sourceNs!, targetNs!); break;
            case "remap":             result = await remapModJar(inputJar!, outputJar!, version!, toMapping!); break;
            case "parchment":         result = await getParchment(className!, mcVersion!); break;
            case "list_parchment":    result = await listParchmentVersions(mcVersion!); break;
            case "parchment_summary": result = await getParchmentSummary(mcVersion!); break;
        }
        return out(result);
    }
);

// ── 8. docs ───────────────────────────────────────────────────────────────────

server.tool(
    "docs",
    "Minecraft modding documentation database. " +
    "action=ingest: add/update doc entries (entries array). " +
    "action=seed: populate built-in defaults (~20 Fabric/MC/NeoForge entries). " +
    "action=get: look up by class name or keyword (query). " +
    "action=search: full-text search (query, category, namespace). " +
    "action=list: list all entries with optional filters (category, namespace, tag, limit). " +
    "action=delete: remove entry by DB id (id).",
    {
        action: z.enum(["ingest","seed","get","search","list","delete"]).describe("Operation to perform"),
        entries: z.array(z.object({
            className: z.string().optional(),
            title:     z.string(),
            summary:   z.string().optional(),
            url:       z.string(),
            category:  z.enum(["minecraft","neoforge","fabric","forge","quilt","mod","other"]).optional().default("minecraft"),
            namespace: z.string().optional().default("vanilla"),
            tags:      z.array(z.string()).optional().default([]),
            source:    z.string().optional().default("manual"),
        })).optional().describe("Doc entries to add/update (ingest)"),
        query:     z.string().optional().describe("Search query (get, search)"),
        category:  z.string().optional().describe("Category filter: minecraft|neoforge|fabric|forge|quilt|mod|other (search, list)"),
        namespace: z.string().optional().describe("Namespace filter: vanilla|neoforge|fabric|forge|parchment (search, list)"),
        tag:       z.string().optional().describe("Tag filter (list)"),
        id:        z.number().optional().describe("DB id to delete (delete)"),
        limit:     z.number().optional().describe("Max results (list, default 100)"),
    },
    async ({ action, entries, query, category, namespace, tag, id, limit }) => {
        let result: unknown;
        switch (action) {
            case "ingest": result = await ingestDocumentation(entries!); break;
            case "seed":   result = await seedDefaultDocumentation(); break;
            case "get":    result = await getDocumentation(query!); break;
            case "search": result = await searchDocumentation(query!, category, namespace); break;
            case "list":   result = await listDocumentation(category, namespace, tag, limit ?? 100); break;
            case "delete": result = await deleteDocumentation(id!); break;
        }
        return out(result);
    }
);

// ── 9. primers ────────────────────────────────────────────────────────────────

server.tool(
    "primers",
    "Minecraft version migration primers and guides. " +
    "action=ingest: add primer entries (entries array). " +
    "action=seed: populate built-in defaults (NeoForge, Forge, Fabric migration guides). " +
    "action=get: get primer by DB id (id). " +
    "action=by_version: get all guides covering a version span (fromVersion, toVersion, modloader). " +
    "action=search: full-text search across primers (query, modloader, fromVersion, toVersion, limit). " +
    "action=list: list all primers (modloader, limit). " +
    "action=delete: remove primer by DB id (id).",
    {
        action: z.enum(["ingest","seed","get","by_version","search","list","delete"]).describe("Operation to perform"),
        entries: z.array(z.object({
            fromVersion:  z.string(),
            toVersion:    z.string(),
            modloader:    z.string().optional(),
            title:        z.string(),
            summary:      z.string().optional(),
            url:          z.string(),
            content:      z.string().optional(),
            tags:         z.array(z.string()).optional(),
            source:       z.string().optional(),
            fetchContent: z.boolean().optional(),
        })).optional().describe("Primer entries to ingest (ingest)"),
        id:          z.number().optional().describe("Primer DB id (get, delete)"),
        fromVersion: z.string().optional().describe("Start of version range (by_version, search)"),
        toVersion:   z.string().optional().describe("End of version range (by_version, search)"),
        modloader:   z.string().optional().describe("neoforge|forge|fabric|quilt filter"),
        query:       z.string().optional().describe("Search keyword(s) (search)"),
        limit:       z.number().optional().describe("Max results"),
    },
    async ({ action, entries, id, fromVersion, toVersion, modloader, query, limit }) => {
        let result: unknown;
        switch (action) {
            case "ingest":     result = await ingestPrimer(entries!); break;
            case "seed":       result = await seedDefaultPrimers(); break;
            case "get":        result = await getPrimer(id!); break;
            case "by_version": result = await getPrimersByVersionRange(fromVersion!, toVersion!, modloader); break;
            case "search":     result = await searchPrimers(query!, modloader, fromVersion, toVersion, limit); break;
            case "list":       result = await listPrimers(modloader, limit); break;
            case "delete":     result = await deletePrimer(id!); break;
        }
        return out(result);
    }
);

// ── 10. mc_registry ───────────────────────────────────────────────────────────

server.tool(
    "mc_registry",
    "Vanilla Minecraft registry and meta data from misode/mcmeta. " +
    "action=blocks: block state property definitions and valid values (version). " +
    "action=commands: full Brigadier command tree (version). " +
    "action=registries: all registry keys, or entries for one specific registry (version, registry). " +
    "action=sounds: sounds.json — all sound events and their file variants (version). " +
    "action=item_components: data-driven item component definitions (version). " +
    "action=registry_entries: full entry list for a registry from the registries branch — more complete than registries action (registry, version). " +
    "action=mcmeta_versions: list all MC versions tracked by misode/mcmeta (filter=release|snapshot|all).",
    {
        action:   z.enum(["blocks","commands","registries","sounds","item_components","registry_entries","mcmeta_versions"]).describe("Operation to perform"),
        version:  z.string().optional().describe("MC version id (default latest)"),
        registry: z.string().optional().describe("Registry key e.g. 'block','item','entity_type','biome' — supports 'minecraft:block' format (registries, registry_entries)"),
        filter:   z.enum(["release","snapshot","all"]).optional().describe("Version filter for mcmeta_versions (default all)"),
    },
    async ({ action, version, registry, filter }) => {
        let result: unknown;
        switch (action) {
            case "blocks":           result = await getMcBlocks(version); break;
            case "commands":         result = await getMcCommands(version); break;
            case "registries":       result = await getMcRegistries(version, registry); break;
            case "sounds":           result = await getMcSounds(version); break;
            case "item_components":  result = await getMcItemComponents(version); break;
            case "registry_entries": result = await getRegistryEntries(registry!, version); break;
            case "mcmeta_versions":  result = await getMcmetaVersions(filter ?? "all"); break;
        }
        return out(result);
    }
);

// ── 11. mc_data ───────────────────────────────────────────────────────────────

server.tool(
    "mc_data",
    "Vanilla Minecraft data browser — tags, recipes, loot tables, lang, blockstates, models, biomes, structures, damage types, enchantments, advancements, particles, entity attributes. " +
    "action=tags: browse tags (version, registry, tagId, namespace). " +
    "action=find_tags_for: reverse tag lookup — all tags containing an entry (entry, registry, version, namespace). " +
    "action=recipes: list recipes with optional type/output filters (version, type, outputItem). " +
    "action=get_recipe: get recipe JSON by id (recipeId, version). " +
    "action=find_recipes_for: all recipes whose output is a given item (item, version). " +
    "action=loot_tables: list loot tables by category (version, category). " +
    "action=get_loot_table: get loot table JSON (path, version). " +
    "action=lang: search en_us.json translation keys/values (version, filter, limit). " +
    "action=blockstate: blockstate JSON for a block (block, version). " +
    "action=model: model JSON with resolved parent chain (modelPath, version, resolveParents). " +
    "action=model_tree: full model inheritance chain with merged textures (modelPath, version). " +
    "action=biomes: list all biomes (version). " +
    "action=get_biome: biome worldgen JSON (biomeId, version). " +
    "action=damage_types: list all damage types with JSON (version). " +
    "action=enchantments: list all enchantments (version). " +
    "action=get_enchantment: enchantment JSON (id, version). " +
    "action=advancements: list advancements by tab (version, category). " +
    "action=get_advancement: advancement JSON (id, version). " +
    "action=structures: list worldgen structures (version). " +
    "action=get_structure: structure JSON (id, version). " +
    "action=particles: list particle types (version). " +
    "action=get_particle: particle description JSON (id, version). " +
    "action=entity_attributes: default entity attributes — vanilla or modded (entity, version, modId).",
    {
        action: z.enum([
            "tags","find_tags_for","recipes","get_recipe","find_recipes_for",
            "loot_tables","get_loot_table","lang","blockstate","model","model_tree",
            "biomes","get_biome","damage_types","enchantments","get_enchantment",
            "advancements","get_advancement","structures","get_structure",
            "particles","get_particle","entity_attributes",
        ]).describe("Operation to perform"),
        version:        z.string().optional().describe("MC version (default 26.1.2)"),
        registry:       z.string().optional().describe("Tag registry: block|item|entity_type|fluid|game_event|... (tags, find_tags_for)"),
        tagId:          z.string().optional().describe("Specific tag ID (tags)"),
        namespace:      z.string().optional().describe("Namespace filter (tags, find_tags_for, default minecraft)"),
        entry:          z.string().optional().describe("Entry to find tags for (find_tags_for), e.g. 'minecraft:iron_ore'"),
        type:           z.string().optional().describe("Recipe type substring filter (recipes): 'crafting_shaped', 'smelting', 'smithing'"),
        outputItem:     z.string().optional().describe("Output item filter (recipes)"),
        recipeId:       z.string().optional().describe("Recipe ID (get_recipe), e.g. 'crafting_table' or 'minecraft:iron_ingot_from_nuggets'"),
        item:           z.string().optional().describe("Item ID for reverse recipe lookup (find_recipes_for), e.g. 'iron_ingot'"),
        category:       z.string().optional().describe("Category (loot_tables: blocks|entities|chests|gameplay; advancements: story|nether|end|adventure|husbandry)"),
        path:           z.string().optional().describe("Loot table path (get_loot_table), e.g. 'blocks/iron_ore' or 'chests/dungeon'"),
        filter:         z.string().optional().describe("Substring filter on key or value (lang)"),
        block:          z.string().optional().describe("Block ID (blockstate), e.g. 'stone', 'oak_door', 'minecraft:grass_block'"),
        modelPath:      z.string().optional().describe("Model path (model, model_tree), e.g. 'block/stone', 'item/diamond_sword'"),
        resolveParents: z.boolean().optional().describe("Follow parent chain and merge textures (model, default true)"),
        biomeId:        z.string().optional().describe("Biome ID (get_biome), e.g. 'minecraft:desert', 'deep_dark'"),
        id:             z.string().optional().describe("ID for get_enchantment, get_advancement, get_structure, get_particle"),
        entity:         z.string().optional().describe("Entity ID (entity_attributes), e.g. 'player', 'zombie'. Omit to list all vanilla attribute files."),
        modId:          z.union([z.string(), z.number()]).optional().describe("Mod ID or numeric DB id for modded entity attribute lookup (entity_attributes)"),
        limit:          z.number().optional().describe("Max results (lang)"),
    },
    async ({ action, version, registry, tagId, namespace, entry, type, outputItem, recipeId, item, category, path, filter, block, modelPath, resolveParents, biomeId, id, entity, modId, limit }) => {
        let result: unknown;
        switch (action) {
            case "tags":             result = await getMcTags(version, registry, tagId, namespace); break;
            case "find_tags_for":    result = await findTagsForEntry(entry!, registry!, version, namespace); break;
            case "recipes":          result = await listRecipes(version, type, outputItem); break;
            case "get_recipe":       result = await getRecipe(version, recipeId!); break;
            case "find_recipes_for": result = await findRecipesForItem(item!, version); break;
            case "loot_tables":      result = await listLootTables(version, category); break;
            case "get_loot_table":   result = await getLootTable(version, path!); break;
            case "lang":             result = await getLangEntries(version, filter, limit); break;
            case "blockstate":       result = await getBlockstate(version, block!); break;
            case "model":            result = await getMcModel(version, modelPath!, resolveParents); break;
            case "model_tree":       result = await getModelTree(modelPath!, version); break;
            case "biomes":           result = await listBiomes(version); break;
            case "get_biome":        result = await getBiome(version, biomeId!); break;
            case "damage_types":     result = await listDamageTypes(version); break;
            case "enchantments":     result = await listEnchantments(version); break;
            case "get_enchantment":  result = await getEnchantment(version, id!); break;
            case "advancements":     result = await listAdvancements(version, category); break;
            case "get_advancement":  result = await getAdvancement(version, id!); break;
            case "structures":       result = await listStructures(version); break;
            case "get_structure":    result = await getStructureData(id!, version); break;
            case "particles":        result = await getMcParticles(version); break;
            case "get_particle":     result = await getParticleData(id!, version); break;
            case "entity_attributes":result = await getEntityAttributes(entity, version, modId); break;
        }
        return out(result);
    }
);

// ── 12. mc_files ─────────────────────────────────────────────────────────────

server.tool(
    "mc_files",
    "Vanilla Minecraft file access via misode/mcmeta GitHub repository. " +
    "action=get_data: fetch a specific data pack file (filePath, version, jsonOnly). " +
    "action=get_asset: fetch a specific resource pack file — binary files are cached locally (filePath, version, jsonOnly). " +
    "action=list_files: list files/directories in a path on a given branch (dirPath, version, branch). " +
    "action=diff: compare a file between two MC versions side-by-side (filePath, versionA, versionB, branch). " +
    "action=atlas: texture atlas definitions (version, atlas — omit atlas to list all). " +
    "action=raw: fetch any mcmeta file by full git ref and path (ref, filePath). " +
    "action=compare: GitHub compare API between two MC versions — lists added/modified/removed files (versionA, versionB, branch). " +
    "action=changelog: files changed in a specific MC version vs previous version (version, branch).",
    {
        action:   z.enum(["get_data","get_asset","list_files","diff","atlas","raw","compare","changelog"]).describe("Operation to perform"),
        filePath: z.string().optional().describe("Relative path within branch (get_data, get_asset, diff, raw), e.g. 'minecraft/recipes/iron_sword.json'"),
        version:  z.string().optional().describe("MC version id (get_data, get_asset, list_files, atlas, changelog)"),
        versionA: z.string().optional().describe("First MC version (diff, compare)"),
        versionB: z.string().optional().describe("Second MC version (diff, compare)"),
        branch:   z.string().optional().describe("mcmeta branch: data|data-json|assets|assets-json|registries|summary|diff|atlas (list_files, diff, compare)"),
        dirPath:  z.string().optional().describe("Directory path to list (list_files), e.g. 'minecraft/recipes' or '' for root"),
        jsonOnly: z.boolean().optional().describe("Use JSON-only branch variant to skip binary files (get_data, get_asset)"),
        atlas:    z.string().optional().describe("Atlas name e.g. 'blocks', 'items' (atlas) — omit to list all atlases"),
        ref:      z.string().optional().describe("Full git ref (raw), e.g. '26.1.2-data', '26.1.2-summary'"),
    },
    async ({ action, filePath, version, versionA, versionB, branch, dirPath, jsonOnly, atlas, ref }) => {
        let result: unknown;
        switch (action) {
            case "get_data":   result = await getMcDataFile(filePath!, version, jsonOnly ?? false); break;
            case "get_asset":  result = await getMcAssetFile(filePath!, version, jsonOnly ?? false); break;
            case "list_files": result = await listMcDataFiles(dirPath!, version!, branch as any); break;
            case "diff":       result = await diffMcData(filePath!, versionA!, versionB!, (branch as any) ?? "data"); break;
            case "atlas":      result = await getMcAtlas(version, atlas); break;
            case "raw":        result = await getMcmetaRaw(ref!, filePath!); break;
            case "compare":    result = await compareVersions(versionA!, versionB!, branch); break;
            case "changelog":  result = await getVersionChangelog(version!, branch); break;
        }
        return out(result);
    }
);

// ── 13. mod_jar ───────────────────────────────────────────────────────────────

server.tool(
    "mod_jar",
    "Mod JAR file access and registry discovery. " +
    "action=list_files: list all files inside a mod JAR, optionally scoped to a path prefix (modId, prefix). " +
    "action=get_file: read any JAR file by internal path — JSON files are parsed (modId, path). " +
    "action=lang: get translation strings from en_us.json with optional filter (modId, filter, limit). " +
    "action=sounds: get sounds.json — all registered sound events and file mappings (modId, namespace). " +
    "action=atlas: get texture atlas JSON (modId, atlas, namespace). " +
    "action=registry_entries: list items/blocks/entities/sounds/containers/potions/paintings/attributes/trims/creative tabs/fluids registered by a mod via lang key inspection — works without decompilation (modId, type, filter, limit). " +
    "action=manifest: read the mod loader manifest (neoforge.mods.toml, mods.toml, fabric.mod.json, quilt.mod.json) — returns raw TOML or parsed JSON (modId). " +
    "action=list_configs: list default config files shipped inside the JAR under defaultconfigs/ or config/ (modId). " +
    "action=get_config: read a specific config file from the JAR by path (modId, path).",
    {
        action:    z.enum(["list_files","get_file","lang","sounds","atlas","registry_entries","manifest","list_configs","get_config"]).describe("Operation to perform"),
        modId:     z.union([z.string(), z.number()]).describe("Mod ID string or numeric DB id"),
        prefix:    z.string().optional().describe("Path prefix to scope listing (list_files), e.g. 'data/mymod/', 'assets/mymod/blockstates/'"),
        path:      z.string().optional().describe("Internal JAR path (get_file, get_config), e.g. 'defaultconfigs/mymod-common.toml'"),
        filter:    z.string().optional().describe("Substring filter on key or value (lang, registry_entries)"),
        namespace: z.string().optional().describe("Namespace override (sounds, atlas)"),
        atlas:     z.string().optional().describe("Atlas name e.g. 'blocks' (atlas)"),
        type:      z.enum(["item","block","entity_type","enchantment","effect","biome","container","sound","potion","banner_pattern","painting","attribute","trim_material","trim_pattern","creative_tab","jukebox_song","death_message","fluid","all"]).optional().describe("Registry type filter (registry_entries, default all)"),
        limit:     z.number().optional().describe("Max entries (lang, registry_entries)"),
    },
    async ({ action, modId, prefix, path, filter, namespace, atlas, type, limit }) => {
        let result: unknown;
        switch (action) {
            case "list_files":       result = await listModJarFiles(modId, prefix); break;
            case "get_file":         result = await getModJarFile(modId, path!); break;
            case "lang":             result = await getModLang(modId, filter, limit); break;
            case "sounds":           result = await getModSounds(modId, namespace); break;
            case "atlas":            result = await getModAtlas(modId, atlas, namespace); break;
            case "registry_entries": result = await listModRegistryEntries(modId, type as any, filter, limit); break;
            case "manifest":         result = await getModManifest(modId); break;
            case "list_configs":     result = await listModConfigs(modId); break;
            case "get_config":       result = await getModConfig(modId, path!); break;
        }
        return out(result);
    }
);

// ── 14. mod_data ─────────────────────────────────────────────────────────────

server.tool(
    "mod_data",
    "Mod JAR structured data content — list or fetch JSON for any data type a mod ships. " +
    "action=list: enumerate all items of a type in the JAR. action=get: fetch full JSON for a specific item. " +
    "action=diff: compare data files between two mod versions — shows added/removed/changed files (dbIdA, dbIdB, dataType optional filter). " +
    "action=trace_item: recursively build the full crafting dependency tree for an item — resolves all recipes that produce it across all mods, then recurses into ingredients (itemId, maxDepth). " +
    "type values: recipe | loot_table | advancement | blockstate | model | biome | structure | data_tag | particle | damage_type | enchantment | " +
    "configured_feature | placed_feature | structure_set | noise | density_function | processor_list | template_pool | " +
    "dimension_type | dimension | trim_material | trim_pattern | painting_variant | wolf_variant | cat_variant | chat_type. " +
    "Common params: modId (required for list/get), namespace (optional scope), filter (list only, substring). " +
    "id: resource id for get, e.g. 'mymod:iron_sword'. modelPath: use instead of id for type=model. " +
    "registry: required for data_tag type, e.g. 'item', 'block', 'entity_type'.",
    {
        action:    z.enum(["list","get","diff","trace_item"]).describe("list/get: JAR data operations; diff: compare two mod versions; trace_item: recipe chain"),
        type:      z.enum(["recipe","loot_table","advancement","blockstate","model","biome","structure","data_tag","particle","damage_type","enchantment","configured_feature","placed_feature","structure_set","noise","density_function","processor_list","template_pool","dimension_type","dimension","trim_material","trim_pattern","painting_variant","wolf_variant","cat_variant","chat_type"]).describe("Data type to query"),
        modId:     z.union([z.string(), z.number()]).optional().describe("Mod ID string or numeric DB id (list, get)"),
        dbIdA:     z.number().optional().describe("Older mod DB id (diff)"),
        dbIdB:     z.number().optional().describe("Newer mod DB id (diff)"),
        itemId:    z.string().optional().describe("Item resource id for trace_item, e.g. 'mekanism:steel_ingot'"),
        maxDepth:  z.number().optional().describe("Max recursion depth for trace_item (default 6)"),
        id:        z.string().optional().describe("Resource id for get, e.g. 'mymod:iron_sword' or 'iron_sword'"),
        modelPath: z.string().optional().describe("Model path for type=model get, e.g. 'block/my_block' or 'mymod:item/my_item'"),
        namespace: z.string().optional().describe("Namespace override / scope filter"),
        filter:    z.string().optional().describe("Substring filter on path (list, diff)"),
        registry:  z.string().optional().describe("Tag registry folder for type=data_tag: item|block|entity_type|fluid|..."),
        dataType:  z.string().optional().describe("Data type substring filter for diff (e.g. 'recipe', 'loot_table')"),
    },
    async ({ action, type, modId, dbIdA, dbIdB, itemId, maxDepth, id, modelPath, namespace, filter, registry, dataType }) => {
        let result: unknown;
        if (action === "diff") {
            result = await diffModData(dbIdA!, dbIdB!, dataType);
        } else if (action === "trace_item") {
            result = await traceRecipeChain(itemId!, maxDepth);
        } else if (action === "list") {
            switch (type) {
                case "recipe":      result = await listModRecipes(modId!, namespace, filter); break;
                case "loot_table":  result = await listModLootTables(modId!, namespace, filter); break;
                case "advancement": result = await listModAdvancements(modId!, namespace, filter); break;
                case "blockstate":  result = await listModBlockstates(modId!, namespace, filter); break;
                case "model":       result = await listModModels(modId!, namespace, filter); break;
                case "biome":       result = await listModBiomes(modId!, namespace, filter); break;
                case "structure":   result = await listModStructures(modId!, namespace, filter); break;
                case "data_tag":    result = await listModDataTags(modId!, registry, namespace, filter); break;
                case "particle":    result = await listModParticles(modId!, namespace, filter); break;
                case "damage_type": result = await listModDamageTypes(modId!, namespace, filter); break;
                case "enchantment": result = await listModEnchantments(modId!, namespace, filter); break;
                default:            result = await listModGenericDataType(modId!, type, namespace, filter); break;
            }
        } else {
            switch (type) {
                case "recipe":      result = await getModRecipe(modId!, id!, namespace); break;
                case "loot_table":  result = await getModLootTable(modId!, id!, namespace); break;
                case "advancement": result = await getModAdvancement(modId!, id!, namespace); break;
                case "blockstate":  result = await getModBlockstate(modId!, id!, namespace); break;
                case "model":       result = await getModModel(modId!, modelPath ?? id!, namespace); break;
                case "biome":       result = await getModBiome(modId!, id!, namespace); break;
                case "structure":   result = await getModStructureData(modId!, id!, namespace); break;
                case "data_tag":    result = await getModDataTag(modId!, registry!, id!, namespace); break;
                case "particle":    result = await getModParticle(modId!, id!, namespace); break;
                case "damage_type": result = await getModDamageType(modId!, id!, namespace); break;
                case "enchantment": result = await getModEnchantment(modId!, id!, namespace); break;
                default:            result = await getModGenericDataType(modId!, type, id!, namespace); break;
            }
        }
        return out(result);
    }
);

// ── 15. mod_tags ──────────────────────────────────────────────────────────────

server.tool(
    "mod_tags",
    "Cross-mod data-pack tag indexing and analysis. " +
    "action=index: scan and index tag files for one mod (modId). " +
    "action=index_all: index tags for ALL ingested mods. " +
    "action=namespaces: list all tag namespaces and registries present across indexed mods. " +
    "action=contributors: show every mod contributing to a specific tag path (tagPath, registry). " +
    "action=expand: recursively unfurl a tag through all nested #tag refs into a flat member list — follows the full tag closure across the DB (tagPath, registry, maxDepth). " +
    "action=mod_list: list all tags registered by a specific mod (modId, registry). " +
    "action=find_conflicts: find replace:true conflicts across all mods (registry optional). " +
    "action=search: search tag paths by substring (query, registry, limit).",
    {
        action:   z.enum(["index","index_all","namespaces","contributors","expand","mod_list","find_conflicts","search"]).describe("Operation to perform"),
        modId:    z.union([z.string(), z.number()]).optional().describe("Mod ID string or DB id (index, mod_list)"),
        tagPath:  z.string().optional().describe("Tag path to look up contributors or expand (contributors, expand), e.g. 'c:ores/iron', '#forge:storage_blocks'"),
        registry: z.string().optional().describe("Registry: block|item|entity_type|fluid|... (contributors, expand, mod_list, find_conflicts, search)"),
        query:    z.string().optional().describe("Substring to match in tag paths (search), e.g. 'ores', 'storage', 'logs'"),
        maxDepth: z.number().optional().describe("Max recursion depth for expand (default 12)"),
        limit:    z.number().optional().describe("Max results (search, default 50)"),
    },
    async ({ action, modId, tagPath, registry, query, maxDepth, limit }) => {
        let result: unknown;
        switch (action) {
            case "index":          result = await indexModTags(modId!); break;
            case "index_all":      result = await indexAllModTags(); break;
            case "namespaces":     result = await listTagNamespaces(); break;
            case "contributors":   result = await getTagContributors(tagPath!, registry); break;
            case "expand":         result = await expandTag(tagPath!, registry, maxDepth); break;
            case "mod_list":       result = await getModTagList(modId!, registry); break;
            case "find_conflicts": result = await findTagConflicts(registry); break;
            case "search":         result = await searchModTags(query!, registry, limit); break;
        }
        return out(result);
    }
);

// ── 16. mixin_scan ────────────────────────────────────────────────────────────

server.tool(
    "mixin_scan",
    "Cross-mod mixin conflict analysis. " +
    "action=list_mods: list all ingested mods that have mixins with their resolved target classes (loader, mcVersion). " +
    "action=conflict_matrix: full matrix of MC classes targeted by 2+ mods (loader, mcVersion, minConflicts). " +
    "action=class_detail: every mod injecting into a specific MC class (targetClass). " +
    "action=hotspots: top-N most contested MC classes by number of mods targeting them (top, loader). " +
    "action=batch_resolve: resolve @Mixin bytecode annotations for all mixin mods and update DB (loader, mcVersion).",
    {
        action:       z.enum(["list_mods","conflict_matrix","class_detail","hotspots","batch_resolve"]).describe("Operation to perform"),
        loader:       z.string().optional().describe("fabric|neoforge|forge|quilt filter"),
        mcVersion:    z.string().optional().describe("MC version substring filter"),
        minConflicts: z.number().optional().describe("Min mods to count as a conflict (conflict_matrix, default 2)"),
        targetClass:  z.string().optional().describe("Fully-qualified class name (class_detail), e.g. 'net/minecraft/world/entity/player/Player'"),
        top:          z.number().optional().describe("How many hotspots to return (hotspots, default 20)"),
    },
    async ({ action, loader, mcVersion, minConflicts, targetClass, top }) => {
        let result: unknown;
        switch (action) {
            case "list_mods":       result = await listModsWithMixins(loader, mcVersion); break;
            case "conflict_matrix": result = await getMixinConflictMatrix(loader, mcVersion, minConflicts); break;
            case "class_detail":    result = await getMixinClassDetail(targetClass!); break;
            case "hotspots":        result = await getMixinHotspots(top, loader); break;
            case "batch_resolve":   result = await batchResolveMixins(loader, mcVersion); break;
        }
        return out(result);
    }
);

// ── 17. gradle ────────────────────────────────────────────────────────────────

server.tool(
    "gradle",
    "Gradle build file analysis across mods. " +
    "action=get_files: get parsed build.gradle / build.gradle.kts for a mod with extracted deps, plugins, and repo URLs (modId). " +
    "action=search: search gradle files across all mods for a text pattern — returns matching lines with context (query, modIdFilter, limit). " +
    "action=compare_deps: compare gradle dependencies across mods — find shared libraries, conflicting versions, embed vs compileOnly (groupFilter, modIdFilter).",
    {
        action:      z.enum(["get_files","search","compare_deps"]).describe("Operation to perform"),
        modId:       z.union([z.string(), z.number()]).optional().describe("Mod ID string or DB id (get_files)"),
        query:       z.string().optional().describe("Text to search for (search), e.g. 'jarJar', 'cursemaven', 'modrinth', a group:artifact"),
        modIdFilter: z.string().optional().describe("Limit to mods whose ID contains this string (search, compare_deps)"),
        groupFilter: z.string().optional().describe("Filter by group:artifact substring (compare_deps), e.g. 'curse.maven', 'net.minecraftforge'"),
        limit:       z.number().optional().describe("Max results (search, default 20)"),
    },
    async ({ action, modId, query, modIdFilter, groupFilter, limit }) => {
        let result: unknown;
        switch (action) {
            case "get_files":    result = await getModGradleFiles(modId!); break;
            case "search":       result = await searchGradleFiles(query!, modIdFilter, limit); break;
            case "compare_deps": result = await compareGradleDeps(groupFilter, modIdFilter); break;
        }
        return out(result);
    }
);

// ── 18. reports ───────────────────────────────────────────────────────────────

server.tool(
    "reports",
    "Generate human-readable Markdown reports from modlens data. " +
    "report=mixin_conflicts: cross-mod mixin conflict report (loader, mcVersion, minConflicts). " +
    "report=tag_conflicts: replace:true tag conflict report (registry). " +
    "report=version_conflicts: duplicate modId and unresolved dep report. " +
    "report=mod_overview: full overview for one mod (modId required). " +
    "report=gradle_deps: gradle dependency comparison report (groupFilter, modIdFilter). " +
    "report=pack_compat: one-shot pack compatibility audit combining mixin conflicts, AT/AW conflicts, tag conflicts, and dep issues (mcVersion, loader). " +
    "report=dep_graph: full mod dependency graph with Mermaid diagram — shows requires/required-by relationships and orphaned mods (mcVersion, modId for single-mod focus). " +
    "report=sidedness: classify all mods as client_only / client_optional / common / server_only (mcVersion, loader). " +
    "report=mod_complexity: rank mods by class count + mixin + AT/AW footprint — useful for crash/lag triage (mcVersion, loader). " +
    "report=pack_changelog: diff two pack snapshots — added/removed/updated mods (oldIds, newIds required). " +
    "savePath: optional absolute path to save the .md file.",
    {
        report:       z.enum(["mixin_conflicts","tag_conflicts","version_conflicts","mod_overview","gradle_deps","pack_compat","dep_graph","sidedness","mod_complexity","pack_changelog"]).describe("Which report to generate"),
        savePath:     z.string().optional().describe("Absolute path to save the .md file, e.g. 'C:/reports/mixin_conflicts.md'"),
        modId:        z.union([z.string(), z.number()]).optional().describe("Required for mod_overview; scopes dep_graph to one mod"),
        loader:       z.string().optional().describe("Loader filter for mixin_conflicts, pack_compat, sidedness, mod_complexity"),
        mcVersion:    z.string().optional().describe("MC version filter for mixin_conflicts, pack_compat, sidedness, mod_complexity, dep_graph"),
        registry:     z.string().optional().describe("Registry filter for tag_conflicts"),
        minConflicts: z.number().optional().describe("Min mods to count as conflict (default 2)"),
        groupFilter:  z.string().optional().describe("Dep group filter for gradle_deps"),
        modIdFilter:  z.string().optional().describe("Mod filter for gradle_deps"),
        dbIds:        z.array(z.number()).optional().describe("DB ids of specific mods to include in pack_compat scope"),
        oldIds:       z.array(z.number()).optional().describe("DB ids of mods in the OLD pack snapshot (pack_changelog)"),
        newIds:       z.array(z.number()).optional().describe("DB ids of mods in the NEW pack snapshot (pack_changelog)"),
    },
    async ({ report, savePath, modId, loader, mcVersion, registry, minConflicts, groupFilter, modIdFilter, dbIds, oldIds, newIds }) => {
        const result = await generateReport({ report, savePath, modId, loader, mcVersion, registry, minConflicts, groupFilter, modIdFilter, dbIds, oldIds, newIds });
        return out(result.savedTo ? `Saved to: ${result.savedTo}\n\n${result.markdown}` : result.markdown);
    }
);

// ── 20. pack_tools ────────────────────────────────────────────────────────────

server.tool(
    "pack_tools",
    "Modpack-specific analysis tools. " +
    "action=asset_conflicts: find assets/ paths shipped by 2+ mods \u2014 last-loaded mod silently wins, causing visual/audio corruption (assetType, mcVersion, loader, limit). " +
    "action=vanilla_overrides: find mods overriding data/minecraft/ or assets/minecraft/ \u2014 affects vanilla recipes, loot tables, textures (overrideType, dataSubtype, mcVersion, loader). " +
    "action=sidedness: determine whether a single mod is client_only / client_optional / common / server_only (modId). " +
    "action=pack_sidedness: classify ALL mods in the DB by sidedness in one pass (mcVersion, loader). " +
    "action=complexity: compute class/mixin/AT/AW complexity score per mod \u2014 ranked list for perf/crash triage (mcVersion, loader). " +
    "action=pack_changelog: diff two pack snapshots by DB id lists \u2014 added/removed/updated mods (oldIds, newIds). " +
    "action=data_conflicts: find data/ paths (recipes, loot_tables, advancements, etc.) shipped by 2+ mods \u2014 last-loaded mod silently wins (dataType, mcVersion, loader, limit).",
    {
        action:      z.enum(["asset_conflicts","vanilla_overrides","sidedness","pack_sidedness","complexity","pack_changelog","data_conflicts"]).describe("Operation to perform"),
        modId:       z.union([z.string(), z.number()]).optional().describe("Mod to analyse (sidedness)"),
        assetType:   z.enum(["textures","models","sounds","blockstates","shaders","all"]).optional().describe("Asset sub-folder filter (asset_conflicts)"),
        dataType:    z.enum(["recipe","loot_tables","advancements","tags","structures","all"]).optional().describe("Data sub-folder filter (data_conflicts)"),
        overrideType:z.enum(["data","assets","all"]).optional().describe("Override type filter (vanilla_overrides)"),
        dataSubtype: z.string().optional().describe("Data subfolder, e.g. 'recipes', 'loot_tables', 'advancements' (vanilla_overrides)"),
        mcVersion:   z.string().optional().describe("MC version filter"),
        loader:      z.string().optional().describe("Loader filter (neoforge|forge|fabric|quilt)"),
        oldIds:      z.array(z.number()).optional().describe("Old pack snapshot DB ids (pack_changelog)"),
        newIds:      z.array(z.number()).optional().describe("New pack snapshot DB ids (pack_changelog)"),
        limit:       z.number().optional().describe("Max conflicts returned (asset_conflicts, data_conflicts, default 300)"),
    },
    async ({ action, modId, assetType, dataType, overrideType, dataSubtype, mcVersion, loader, oldIds, newIds, limit }) => {
        let result: unknown;
        switch (action) {
            case "asset_conflicts":   result = await findAssetConflicts(assetType, mcVersion, loader, limit); break;
            case "vanilla_overrides": result = await findVanillaOverrides(overrideType, dataSubtype, mcVersion, loader); break;
            case "sidedness":         result = await analyzeModSidedness(modId!); break;
            case "pack_sidedness":    result = await analyzePackSidedness(mcVersion, loader); break;
            case "complexity":        result = await computeModComplexity(mcVersion, loader); break;
            case "pack_changelog":    result = await computePackChangelog(oldIds!, newIds!); break;
            case "data_conflicts":    result = await findDataConflicts(dataType, mcVersion, loader, limit); break;
        }
        return out(result);
    }
);

// ── 21. kubejs ────────────────────────────────────────────────────────────────

server.tool(
    "kubejs",
    "KubeJS script analysis tools. " +
    "action=index: scan a kubejs scripts directory and produce a per-file breakdown of which event categories are touched \u2014 recipe changes, tag modifications, loot overrides, item/block registration, worldgen, etc. (scriptsDir). " +
    "action=search: full-text search across all scripts in a directory (scriptsDir, query, limit).",
    {
        action:     z.enum(["index","search"]).describe("Operation to perform"),
        scriptsDir: z.string().describe("Absolute path to the kubejs/ folder or a subfolder like kubejs/server_scripts/"),
        query:      z.string().optional().describe("Text to search for (search action)"),
        limit:      z.number().optional().describe("Max search results (default 60)"),
    },
    async ({ action, scriptsDir, query, limit }) => {
        let result: unknown;
        switch (action) {
            case "index":  result = await indexKubeJsScripts(scriptsDir); break;
            case "search": result = await searchKubeJsScripts(scriptsDir, query!, limit); break;
        }
        return out(result);
    }
);

// ── 22. analyze_crash_log ────────────────────────────────────────────────────

server.tool(
    "analyze_crash_log",
    "Paste a NeoForge/Forge/Fabric crash log and get a ranked list of suspect mods. " +
    "Cross-references stack frames against the ModClass index (populated by reindex_classes). " +
    "Also extracts the '-- Mod List --' section when present. " +
    "Returns suspects ranked by frame count, recognized/unrecognized frame counts, and a coverage warning if the class index is sparse.",
    {
        logText: z.string().describe("Full text of the crash report or log snippet"),
    },
    async ({ logText }) => {
        const result = await analyzeCrashLog(logText);
        return out(result);
    }
);

// ── 23. find_missing_deps ────────────────────────────────────────────────────

server.tool(
    "find_missing_deps",
    "Find declared mod dependencies that are not satisfied by any ingested mod in the DB. " +
    "Reads the dependencies JSON column from all mods, collects the full ingested modId set, " +
    "and flags any referenced modId that is absent. " +
    "Skips loader-level pseudo-deps (minecraft, neoforge, forge, fabric-api, java, etc.).",
    {
        mcVersion: z.string().optional().describe("Filter checked mods to this MC version"),
        loader:    z.string().optional().describe("Filter checked mods to this loader (neoforge|forge|fabric|quilt)"),
    },
    async ({ mcVersion, loader }) => {
        const result = await findMissingDeps(mcVersion, loader);
        return out(result);
    }
);

// ── 24. check_mod_compat ──────────────────────────────────────────────────────

server.tool(
    "check_mod_compat",
    "Pre-flight compatibility check for a candidate mod JAR before adding it to a pack. " +
    "Does NOT require the JAR to be ingested first. " +
    "Checks against all mods currently in the DB for: " +
    "(1) mixin target conflicts (error), " +
    "(2) Access Transformer/Widener overlaps (error), " +
    "(3) asset path conflicts (warn), " +
    "(4) missing declared dependencies (warn), " +
    "(5) sidedness info (client_only/server_only). " +
    "Returns issues[], summary.safe (true if no errors), and candidate metadata.",
    {
        jarPath:   z.string().describe("Absolute path to the candidate mod JAR"),
        mcVersion: z.string().optional().describe("Filter comparison pool to this MC version"),
        loader:    z.string().optional().describe("Filter comparison pool to this loader (neoforge|forge|fabric|quilt)"),
    },
    async ({ jarPath, mcVersion, loader }) => {
        const result = await checkModCompat(jarPath, mcVersion, loader);
        return out(result);
    }
);

// ── Start ─────────────────────────────────────────────────────────────────────

process.on("SIGINT", async () => { await disconnect(); process.exit(0); });
process.on("SIGTERM", async () => { await disconnect(); process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
