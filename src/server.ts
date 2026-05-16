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
import { indexMcVersion, searchMcIndexed, indexMcSourceSemantic, searchMcSourceSemantic } from "./tools/mc-fts.js";
import { findMapping, remapModJar, getParchment, listParchmentVersions, getParchmentSummary } from "./tools/mappings.js";
import { ingestDocumentation, getDocumentation, searchDocumentation, listDocumentation, deleteDocumentation, seedDefaultDocumentation, semanticSearchDocumentation, backfillDocEmbeddings } from "./tools/docs.js";
import {
    getMcmetaVersions, getMcBlocks, getMcCommands, getMcRegistries, getMcSounds, getMcItemComponents,
    getMcDataFile, getMcAssetFile, listMcDataFiles, diffMcData, getMcAtlas, getMcmetaRaw, getRegistryEntries,
    compareVersions, getVersionChangelog,
} from "./tools/mcmeta.js";
import {
    ingestPrimer, getPrimer, getPrimersByVersionRange, searchPrimers, listPrimers, deletePrimer, seedDefaultPrimers,
    semanticSearchPrimers, backfillPrimerEmbeddings,
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
import { searchPacksAction, featuredPacksAction, packInfoAction, packManifestAction, syncPackModsAction, searchFtbModsAction, ftbModInfoAction } from "./tools/modpacks-ch.js";
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
    "Mod database, decompile, and source browser. action=ingest|list|get|search|stats|dependencies|dep_graph|version_conflicts|source_urls|decompile|decompile_status|decompile_class|source|search_source|reindex|batch_ingest. Omit dbId on search_source to grep all decompiled mods. batch_ingest replace=true removes old modId row first.",
    {
        action: z.enum([
            "ingest","list","get","search","stats","dependencies","dep_graph",
            "version_conflicts","source_urls","decompile","decompile_status",
            "decompile_class","source","search_source","reindex","batch_ingest",
        ]),
        jarPath:      z.string().optional(),
        modId:        z.union([z.string(), z.number()]).optional().describe("mod ID or DB id"),
        dbId:         z.number().optional().describe("DB id"),
        query:        z.string().optional(),
        path:         z.string().optional(),
        className:    z.string().optional(),
        loader:       z.string().optional().describe("fabric|neoforge|forge|quilt"),
        mcVersion:    z.string().optional(),
        hasMixins:    z.boolean().optional(),
        decompiled:   z.boolean().optional(),
        recursive:    z.boolean().optional(),
        skipSource:   z.boolean().optional(),
        isRegex:      z.boolean().optional(),
        force:        z.boolean().optional(),
        limit:        z.number().optional(),
        directory:    z.string().optional().describe("Directory of JARs (batch_ingest)"),
        indexClasses: z.boolean().optional(),
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
    "Mod JAR bytecode and class analysis. action=search_class|class_members|bytecode|find_refs|cross_refs|inheritance|diff|find_implementors|scan_registrations|annotated_by|event_listeners|optional_integrations|network_payloads|config_schema.",
    {
        action:     z.enum(["search_class","class_members","bytecode","find_refs","cross_refs","inheritance","diff","find_implementors","scan_registrations","annotated_by","event_listeners","optional_integrations","network_payloads","config_schema"]),
        dbId:      z.number().optional().describe("DB id"),
        dbIdA:     z.number().optional().describe("older DB id"),
        dbIdB:     z.number().optional().describe("newer DB id"),
        query:     z.string().optional(),
        className: z.string().optional(),
        target:    z.string().optional().describe("slash/dot class/method/field, e.g. 'Cls:meth:(I)V'"),
        annotation:z.string().optional().describe("slash/dot annotation class"),
        event:     z.string().optional().describe("slash/dot event class"),
        modId:     z.union([z.string(), z.number()]).optional(),
        transitive:z.boolean().optional(),
        mcVersion: z.string().optional(),
        loader:    z.string().optional(),
        limit:     z.number().optional(),
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
    "Mod mixin and access transformer analysis. action=targets|resolve|conflicts|targets_in_package|at_conflicts|at_entries|aw_entries.",
    {
        action:        z.enum(["targets","resolve","conflicts","targets_in_package","at_conflicts","at_entries","aw_entries"]),
        modId:         z.union([z.string(), z.number()]).optional().describe("mod ID or DB id"),
        dbId:          z.number().optional().describe("DB id"),
        targetClass:   z.string().optional().describe("slash/dot class name"),
        packagePrefix: z.string().optional().describe("slash/dot package prefix"),
        mcVersion:     z.string().optional(),
        loader:        z.string().optional(),
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
    "Modrinth/CurseForge platform sync and source download. action=sync_modrinth|sync_curseforge|check_updates|batch_sync|download_source.",
    {
        action:          z.enum(["sync_modrinth","sync_curseforge","check_updates","batch_sync","download_source"]),
        dbId:            z.number().optional().describe("DB id"),
        syncModrinth:    z.boolean().optional(),
        syncCurseforge:  z.boolean().optional(),
        downloadSources: z.boolean().optional(),
        modIdFilter:     z.string().optional(),
        limit:           z.number().optional(),
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

// ── 5. modpacks_ch ───────────────────────────────────────────────────────────

server.tool(
    "modpacks_ch",
    "Search and sync modpacks from the FTB (modpacks.ch) and CurseForge namespaces — no API key required. " +
    "action=search|featured|info|manifest|sync_pack_mods|search_ftb_mods|ftb_mod_info. " +
    "namespace=ftb|curseforge (default: ftb). " +
    "User-Agent is set per FTB team request for usage tracking.",
    {
        action:       z.enum(["search", "featured", "info", "manifest", "sync_pack_mods", "search_ftb_mods", "ftb_mod_info"]),
        namespace:    z.enum(["ftb", "curseforge"]).optional().describe("ftb or curseforge (default: ftb)"),
        packId:       z.number().optional().describe("Pack ID (required for info, manifest, sync_pack_mods)"),
        versionId:    z.number().optional().describe("Version ID (required for manifest, sync_pack_mods)"),
        query:        z.string().optional().describe("Search query (required for search, search_ftb_mods)"),
        modId:        z.union([z.number(), z.string()]).optional().describe("FTB mod ID (required for ftb_mod_info)"),
        limit:        z.number().optional().describe("Max results for search/featured (default: 20)"),
        fileTypes:    z.array(z.string()).optional().describe("File types to ingest (default: ['mod','resource'])"),
        skipServer:   z.boolean().optional().describe("Skip server-only files (default: false)"),
        skipOptional: z.boolean().optional().describe("Skip optional files (default: false)"),
        concurrency:  z.number().optional().describe("Parallel downloads for sync_pack_mods (default: 3)"),
    },
    async ({ action, namespace, packId, versionId, query, modId, limit, fileTypes, skipServer, skipOptional, concurrency }) => {
        const ns = namespace ?? "ftb";
        let result: unknown;
        switch (action) {
            case "search":
                if (!query) throw new Error("query is required for action=search");
                result = await searchPacksAction(query, ns, limit ?? 20);
                break;
            case "featured":
                result = await featuredPacksAction(limit ?? 20);
                break;
            case "info":
                if (!packId) throw new Error("packId is required for action=info");
                result = await packInfoAction(packId, ns);
                break;
            case "manifest":
                if (!packId)    throw new Error("packId is required for action=manifest");
                if (!versionId) throw new Error("versionId is required for action=manifest");
                result = await packManifestAction(packId, versionId, ns);
                break;
            case "sync_pack_mods":
                if (!packId)    throw new Error("packId is required for action=sync_pack_mods");
                if (!versionId) throw new Error("versionId is required for action=sync_pack_mods");
                result = await syncPackModsAction({ packId, versionId, namespace: ns, fileTypes, skipServer, skipOptional, concurrency });
                break;
            case "search_ftb_mods":
                if (!query) throw new Error("query is required for action=search_ftb_mods");
                result = await searchFtbModsAction(query, limit ?? 20);
                break;
            case "ftb_mod_info":
                if (modId === undefined) throw new Error("modId is required for action=ftb_mod_info");
                result = await ftbModInfoAction(modId);
                break;
        }
        return out(result);
    },
);

// ── 6. mc_versions ────────────────────────────────────────────────────────────

server.tool(
    "mc_versions",
    "Minecraft and mod loader version management. action=list_mc|list_neoforge|list_fabric|ingest_neoforge|ingest_fabric.",
    {
        action:    z.enum(["list_mc","list_neoforge","list_fabric","ingest_neoforge","ingest_fabric"]),
        type:      z.enum(["release","snapshot","all"]).optional(),
        mcVersion: z.string().optional(),
        version:   z.string().optional(),
        skipIndex: z.boolean().optional(),
        limit:     z.number().optional(),
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
    "Vanilla Minecraft source code, decompilation, and validation. action=search_class|get_source|bytecode|class_members|find_refs|inheritance|diff|decompile|decompile_status|search_code|index|search_indexed|search_events|validate_aw|analyze_mixin|index_semantic|search_semantic. index_semantic/search_semantic require Ollama running.",
    {
        action:     z.enum(["search_class","get_source","bytecode","class_members","find_refs","inheritance","diff","decompile","decompile_status","search_code","index","search_indexed","search_events","validate_aw","analyze_mixin","index_semantic","search_semantic"]),
        version:    z.string().optional(),
        versionA:   z.string().optional(),
        versionB:   z.string().optional(),
        mcVersion:  z.string().optional(),
        query:      z.string().optional(),
        className:  z.string().optional(),
        target:     z.string().optional().describe("slash/dot class/method/field, e.g. 'Cls:meth:(I)V'"),
        searchType: z.enum(["class","method","field","content","all"]).optional(),
        isRegex:    z.boolean().optional(),
        force:      z.boolean().optional(),
        modloader:  z.enum(["minecraft","neoforge"]).optional(),
        content:    z.string().optional().describe("Full .accesswidener file text (validate_aw)"),
        source:     z.string().optional().describe("Full mixin Java source code (analyze_mixin)"),
        startLine:  z.number().optional().describe("1-based start line"),
        endLine:    z.number().optional().describe("1-based end line"),
        maxLines:   z.number().optional(),
        limit:      z.number().optional(),
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
            case "index_semantic":  result = await indexMcSourceSemantic(version!, (limit as number | undefined) ?? 50); break;
            case "search_semantic": result = await searchMcSourceSemantic(query!, version!, limit ?? 10); break;
        }
        return out(result);
    }
);

// ── 7. mappings ───────────────────────────────────────────────────────────────

server.tool(
    "mappings",
    "Minecraft name mappings (official/intermediary/yarn/mojmap) and Parchment parameter docs. action=find|remap|parchment|list_parchment|parchment_summary.",
    {
        action:    z.enum(["find","remap","parchment","list_parchment","parchment_summary"]),
        symbol:    z.string().optional().describe("symbol to translate"),
        version:   z.string().optional(),
        sourceNs:  z.enum(["official","intermediary","yarn","mojmap"]).optional(),
        targetNs:  z.enum(["official","intermediary","yarn","mojmap"]).optional(),
        inputJar:  z.string().optional(),
        outputJar: z.string().optional(),
        toMapping: z.enum(["yarn","mojmap"]).optional(),
        className: z.string().optional(),
        mcVersion: z.string().optional(),
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
    "Minecraft modding documentation database. action=ingest|seed|get|search|list|delete|semantic_search|backfill_embeddings. semantic_search requires Ollama running.",
    {
        action: z.enum(["ingest","seed","get","search","list","delete","semantic_search","backfill_embeddings"]),
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
        query:     z.string().optional(),
        category:  z.string().optional().describe("minecraft|neoforge|fabric|forge|quilt|mod|other"),
        namespace: z.string().optional(),
        tag:       z.string().optional(),
        id:        z.number().optional(),
        limit:     z.number().optional(),
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
            case "semantic_search":     result = await semanticSearchDocumentation(query!, limit ?? 10); break;
            case "backfill_embeddings": result = await backfillDocEmbeddings(); break;
        }
        return out(result);
    }
);

// ── 9. primers ────────────────────────────────────────────────────────────────

server.tool(
    "primers",
    "Minecraft version migration primers and porting guides. action=ingest|seed|get|by_version|search|list|delete|semantic_search|backfill_embeddings. semantic_search requires Ollama running.",
    {
        action: z.enum(["ingest","seed","get","by_version","search","list","delete","semantic_search","backfill_embeddings"]),
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
        id:          z.number().optional(),
        fromVersion: z.string().optional(),
        toVersion:   z.string().optional(),
        modloader:   z.string().optional().describe("neoforge|forge|fabric|quilt"),
        query:       z.string().optional(),
        limit:       z.number().optional(),
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
            case "semantic_search":     result = await semanticSearchPrimers(query!, limit ?? 10); break;
            case "backfill_embeddings": result = await backfillPrimerEmbeddings(); break;
        }
        return out(result);
    }
);

// ── 10. mc_registry ───────────────────────────────────────────────────────────

server.tool(
    "mc_registry",
    "Vanilla MC registry and meta data (blocks, commands, registries, sounds, item components). action=blocks|commands|registries|sounds|item_components|registry_entries|mcmeta_versions.",
    {
        action:   z.enum(["blocks","commands","registries","sounds","item_components","registry_entries","mcmeta_versions"]),
        version:  z.string().optional(),
        registry: z.string().optional().describe("registry key e.g. 'block','item','entity_type'"),
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
    "Vanilla MC data browser — tags, recipes, loot tables, lang, blockstates, models, biomes, enchantments, advancements, structures, particles, entity attributes. action=tags|find_tags_for|recipes|get_recipe|find_recipes_for|loot_tables|get_loot_table|lang|blockstate|model|model_tree|biomes|get_biome|damage_types|enchantments|get_enchantment|advancements|get_advancement|structures|get_structure|particles|get_particle|entity_attributes.",
    {
        action: z.enum([
            "tags","find_tags_for","recipes","get_recipe","find_recipes_for",
            "loot_tables","get_loot_table","lang","blockstate","model","model_tree",
            "biomes","get_biome","damage_types","enchantments","get_enchantment",
            "advancements","get_advancement","structures","get_structure",
            "particles","get_particle","entity_attributes",
        ]),
        version:        z.string().optional(),
        registry:       z.string().optional().describe("tag registry e.g. block|item|entity_type"),
        tagId:          z.string().optional(),
        namespace:      z.string().optional(),
        entry:          z.string().optional().describe("Entry to find tags for (find_tags_for), e.g. 'minecraft:iron_ore'"),
        type:           z.string().optional().describe("recipe type e.g. 'crafting_shaped'"),
        outputItem:     z.string().optional(),
        recipeId:       z.string().optional().describe("recipe id"),
        item:           z.string().optional().describe("item id"),
        category:       z.string().optional().describe("loot: blocks|entities|chests|gameplay; advancements: story|nether|end|adventure"),
        path:           z.string().optional().describe("loot table path e.g. 'blocks/iron_ore'"),
        filter:         z.string().optional(),
        block:          z.string().optional().describe("block id"),
        modelPath:      z.string().optional().describe("model path e.g. 'block/stone'"),
        resolveParents: z.boolean().optional(),
        biomeId:        z.string().optional().describe("biome id"),
        id:             z.string().optional(),
        entity:         z.string().optional().describe("entity id e.g. 'player'"),
        modId:          z.union([z.string(), z.number()]).optional().describe("mod ID or DB id"),
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
    "Vanilla MC file access via misode/mcmeta (data packs, assets, atlases, diffs, changelogs). action=get_data|get_asset|list_files|diff|atlas|raw|compare|changelog.",
    {
        action:   z.enum(["get_data","get_asset","list_files","diff","atlas","raw","compare","changelog"]),
        filePath: z.string().optional().describe("relative path in branch"),
        version:  z.string().optional(),
        versionA: z.string().optional(),
        versionB: z.string().optional(),
        branch:   z.string().optional().describe("data|assets|registries|summary|diff|atlas"),
        dirPath:  z.string().optional(),
        jsonOnly: z.boolean().optional(),
        atlas:    z.string().optional().describe("atlas name e.g. 'blocks'"),
        ref:      z.string().optional().describe("git ref e.g. '26.1.2-data'"),
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
    "Mod JAR file access and registry discovery (lang, sounds, atlases, configs, manifests). action=list_files|get_file|lang|sounds|atlas|registry_entries|manifest|list_configs|get_config.",
    {
        action:    z.enum(["list_files","get_file","lang","sounds","atlas","registry_entries","manifest","list_configs","get_config"]),
        modId:     z.union([z.string(), z.number()]).describe("mod ID or DB id"),
        prefix:    z.string().optional(),
        path:      z.string().optional().describe("internal JAR path"),
        filter:    z.string().optional(),
        namespace: z.string().optional(),
        atlas:     z.string().optional().describe("Atlas name e.g. 'blocks' (atlas)"),
        type:      z.enum(["item","block","entity_type","enchantment","effect","biome","container","sound","potion","banner_pattern","painting","attribute","trim_material","trim_pattern","creative_tab","jukebox_song","death_message","fluid","all"]).optional().describe("Registry type filter (registry_entries, default all)"),
        limit:     z.number().optional(),
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
    "Mod JAR structured data — list/get/diff JSON (recipes, loot tables, advancements, blockstates, models, biomes, tags, etc.) or trace a crafting dependency tree. action=list|get|diff|trace_item.",
    {
        action:    z.enum(["list","get","diff","trace_item"]).describe("list/get: JAR data operations; diff: compare two mod versions; trace_item: recipe chain"),
        type:      z.enum(["recipe","loot_table","advancement","blockstate","model","biome","structure","data_tag","particle","damage_type","enchantment","configured_feature","placed_feature","structure_set","noise","density_function","processor_list","template_pool","dimension_type","dimension","trim_material","trim_pattern","painting_variant","wolf_variant","cat_variant","chat_type"]).describe("Data type to query"),
        modId:     z.union([z.string(), z.number()]).optional().describe("mod ID or DB id"),
        dbIdA:     z.number().optional().describe("older DB id"),
        dbIdB:     z.number().optional().describe("newer DB id"),
        itemId:    z.string().optional().describe("resource id e.g. 'mekanism:steel_ingot'"),
        maxDepth:  z.number().optional(),
        id:        z.string().optional().describe("resource id"),
        modelPath: z.string().optional().describe("model path"),
        namespace: z.string().optional(),
        filter:    z.string().optional().describe("Substring filter on path (list, diff)"),
        registry:  z.string().optional().describe("tag registry e.g. item|block|entity_type"),
        dataType:  z.string().optional(),
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
    "Cross-mod data-pack tag indexing — index, browse, expand, find contributors, and detect replace:true conflicts. action=index|index_all|namespaces|contributors|expand|mod_list|find_conflicts|search.",
    {
        action:   z.enum(["index","index_all","namespaces","contributors","expand","mod_list","find_conflicts","search"]),
        modId:    z.union([z.string(), z.number()]).optional().describe("Mod ID string or DB id (index, mod_list)"),
        tagPath:  z.string().optional().describe("Tag path to look up contributors or expand (contributors, expand), e.g. 'c:ores/iron', '#forge:storage_blocks'"),
        registry: z.string().optional().describe("block|item|entity_type|fluid|..."),
        query:    z.string().optional(),
        maxDepth: z.number().optional(),
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
    "Cross-mod mixin conflict analysis. action=list_mods|conflict_matrix|class_detail|hotspots|batch_resolve.",
    {
        action:       z.enum(["list_mods","conflict_matrix","class_detail","hotspots","batch_resolve"]),
        loader:       z.string().optional().describe("fabric|neoforge|forge|quilt"),
        mcVersion:    z.string().optional(),
        minConflicts: z.number().optional(),
        targetClass:  z.string().optional().describe("slash/dot class name"),
        top:          z.number().optional(),
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
    "Gradle build file analysis — extract deps/plugins, search across mods, compare dependency versions. action=get_files|search|compare_deps.",
    {
        action:      z.enum(["get_files","search","compare_deps"]),
        modId:       z.union([z.string(), z.number()]).optional().describe("Mod ID string or DB id (get_files)"),
        query:       z.string().optional(),
        modIdFilter: z.string().optional().describe("modId substring filter"),
        groupFilter: z.string().optional().describe("group:artifact substring"),
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
    "Generate Markdown reports. report=mixin_conflicts|tag_conflicts|version_conflicts|mod_overview|gradle_deps|pack_compat|dep_graph|sidedness|mod_complexity|pack_changelog. savePath to write to disk.",
    {
        report:       z.enum(["mixin_conflicts","tag_conflicts","version_conflicts","mod_overview","gradle_deps","pack_compat","dep_graph","sidedness","mod_complexity","pack_changelog"]),
        savePath:     z.string().optional().describe("Absolute path to save the .md file, e.g. 'C:/reports/mixin_conflicts.md'"),
        modId:        z.union([z.string(), z.number()]).optional(),
        loader:       z.string().optional(),
        mcVersion:    z.string().optional(),
        registry:     z.string().optional(),
        minConflicts: z.number().optional(),
        groupFilter:  z.string().optional(),
        modIdFilter:  z.string().optional(),
        dbIds:        z.array(z.number()).optional(),
        oldIds:       z.array(z.number()).optional(),
        newIds:       z.array(z.number()).optional(),
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
        action:      z.enum(["asset_conflicts","vanilla_overrides","sidedness","pack_sidedness","complexity","pack_changelog","data_conflicts"]),
        modId:       z.union([z.string(), z.number()]).optional(),
        assetType:   z.enum(["textures","models","sounds","blockstates","shaders","all"]).optional().describe("Asset sub-folder filter (asset_conflicts)"),
        dataType:    z.enum(["recipe","loot_tables","advancements","tags","structures","all"]).optional().describe("Data sub-folder filter (data_conflicts)"),
        overrideType:z.enum(["data","assets","all"]).optional().describe("Override type filter (vanilla_overrides)"),
        dataSubtype: z.string().optional().describe("Data subfolder, e.g. 'recipes', 'loot_tables', 'advancements' (vanilla_overrides)"),
        mcVersion:   z.string().optional(),
        loader:      z.string().optional(),
        oldIds:      z.array(z.number()).optional(),
        newIds:      z.array(z.number()).optional(),
        limit:       z.number().optional(),
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
    "KubeJS script analysis — index a kubejs/ directory or text-search scripts. action=index|search.",
    {
        action:     z.enum(["index","search"]),
        scriptsDir: z.string().describe("Absolute path to the kubejs/ folder or a subfolder like kubejs/server_scripts/"),
        query:      z.string().optional(),
        limit:      z.number().optional(),
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
    "Parse a NeoForge/Forge/Fabric crash log and return suspect mods ranked by stack-frame hits against the indexed class DB.",
    {
        logText: z.string().describe("full crash log text"),
    },
    async ({ logText }) => {
        const result = await analyzeCrashLog(logText);
        return out(result);
    }
);

// ── 23. find_missing_deps ────────────────────────────────────────────────────

server.tool(
    "find_missing_deps",
    "Find declared mod dependencies not satisfied by any ingested mod in the DB. Skips loader pseudo-deps (minecraft, neoforge, java, etc.).",
    {
        mcVersion: z.string().optional(),
        loader:    z.string().optional().describe("neoforge|forge|fabric|quilt"),
    },
    async ({ mcVersion, loader }) => {
        const result = await findMissingDeps(mcVersion, loader);
        return out(result);
    }
);

// ── 24. check_mod_compat ──────────────────────────────────────────────────────

server.tool(
    "check_mod_compat",
    "Pre-flight check a candidate JAR against the DB — mixin conflicts, AT/AW overlaps, asset conflicts, missing deps, sidedness. Does not require prior ingestion.",
    {
        jarPath:   z.string().describe("Absolute path to the candidate mod JAR"),
        mcVersion: z.string().optional(),
        loader:    z.string().optional().describe("neoforge|forge|fabric|quilt"),
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
