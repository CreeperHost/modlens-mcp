import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { startupEmbedScan } from "./embed-queue.js";

import { ingestMod, decompileMod, decompileModStatus, reindexClasses, batchIngest, batchDecompileMods, deleteModFull, refreshDegradedMetadata } from "./tools/ingest.js";
import { listMods, getModDetails, searchMods, getDbStats, getDependencies, findVersionConflicts, getDependencyGraph, listModSourceUrls, listModRegistryEntries } from "./tools/catalog.js";
import {
    listModJarFiles, getModJarFile,
    getModModel,
    getModLang, getModSounds,
    listModDataTags, getModDataTag,
    getModAtlas,
    listModGenericDataType, getModGenericDataType,
    getModManifest, listModConfigs, getModConfig,
    diffModData,
    listModData, getModData,
} from "./tools/mod-data.js";
import { traceRecipeChain } from "./tools/mod-data.js";
import { getModSource, searchSource, decompileModClass } from "./tools/source.js";
import { buildModGraph, graphBuildStatus, queryModGraph, getGraphReport, enrichNextChunk, submitEnrichment, downloadGraph, exportGraph, submitGraph } from "./tools/graphify.js";
import { exportEmbeddings, downloadEmbeddings, downloadPackEmbeddings, getEmbedStatus, submitEmbeddings } from "./tools/embed-registry.js";
import {
    searchModClass, getModClassMembers, getModClassBytecode,
    findModReferences, getModInheritance, diffModVersions, findImplementors,
    scanModRegistrations, findAnnotatedClasses,
    crossModRefs, findEventListeners,
    findOptionalIntegrations, findNetworkPayloads, extractConfigSchema,
} from "./tools/bytecode.js";
import { getMixinTargets, getMixinConflicts, getAtEntries, getAwEntries, resolveMixinTargets, getMixinsTargetingPackage, findAtAwConflicts } from "./tools/mixin-scan.js";
import { syncModrinth, syncCurseforge, checkUpdates, downloadSource, batchSyncSources, searchPlatforms, batchCheckUpdates } from "./tools/platform.js";
import { listMcVersions, listNeoForgeVersions, listFabricApiVersions, listForgeVersions, downloadNeoForge, downloadFabricApi, downloadForge } from "./platform.js";
import {
    searchMinecraftClass, getMinecraftSource, getMcClassBytecode, getMcClassMembers,
    findMcReferences, getMcInheritance, diffMcVersions,
    decompileMcVersion, decompileMcVersionStatus, searchMcCode,
    validateAccessWidener, analyzeMixin, searchEvents,
} from "./tools/vanilla.js";
import { diffMcVersionsDetailed, diffModVersionsDetailed } from "./tools/version-diff.js";
import { indexMcVersion, searchMcIndexed, indexMcSourceSemantic, searchMcSourceSemantic, indexModSourceFts, indexModSourceSemantic, searchModSourceIndexed, searchModSourceSemantic } from "./tools/mc-fts.js";
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
import { findAssetConflicts, findVanillaOverrides, analyzeModSidedness, analyzePackSidedness, computeModComplexity, computePackChangelog, findDataConflicts, buildPackGraph, diffPackConfigs, packHealth } from "./tools/packtools.js";
import { indexKubeJsScripts, searchKubeJsScripts, semanticSearchKubeJsScripts } from "./tools/kubejs.js";
import { searchPacksAction, featuredPacksAction, packInfoAction, packManifestAction, syncPackModsAction, searchFtbModsAction, ftbModInfoAction, downloadModAction, downloadOverridesAction, listPackVersionsAction, listPackFilesAction, findModInPacksAction } from "./tools/modpacks-ch.js";
import { analyzeCrashLog, findMissingDeps } from "./tools/diagnostics.js";
import { checkModCompat } from "./tools/compat-check.js";
import { disconnect } from "./db.js";
import { mcPaths } from "./minecraft.js";
import { findModById, resolveModRefSlim } from "./repositories/mod.js";
import { CACHE_ROOT } from "./cache.js";

// Load .env — try ~/.modlens/.env first (npx/installed users), then local .env (git-clone users)
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ENV_PATH } from "./env-path.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Always attempt to load the resolved ENV_PATH (covers both modes)
const localEnvPath = join(__dirname, "..", ".env");
for (const ep of [ENV_PATH, localEnvPath]) {
    if (existsSync(ep)) {
        for (const line of readFileSync(ep, "utf8").split("\n")) {
            const m = line.match(/^([^#=]+)=(.*)$/);
            if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, "");
        }
        break; // only load the first one found
    }
}

// Version is sourced from package.json so it stays in sync with releases.
// package.json sits one level up from both src/ (dev) and dist/ (built).
const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

// ── Server-side logging ─────────────────────────────────────────────────────
//
// In stdio mode stderr is piped to the MCP *client's* log, so we stay quiet by
// default to avoid polluting it. In HTTP mode the process owns its own console,
// so verbose logging is enabled automatically — full stack traces and the exact
// failing params land in the server log instead of having to be fished out of
// the model's reply. MODLENS_VERBOSE forces it on (1/true/yes) or off (0/false/no).
const VERBOSE = process.env.MODLENS_VERBOSE
    ? !/^(0|false|no|off)$/i.test(process.env.MODLENS_VERBOSE)
    : !!process.env.MCP_PORT;

/** Best-effort, bounded JSON for logging tool params (handles circular refs). */
function previewArgs(value: unknown): string {
    try {
        const json = JSON.stringify(value);
        if (json == null) return String(value);
        return json.length > 2000 ? json.slice(0, 2000) + "…(truncated)" : json;
    } catch {
        return "[unserializable params]";
    }
}

/** Log a full error (stack + context) to stderr when verbose logging is on. */
function logServerError(context: string, err: unknown, params?: unknown): void {
    if (!VERBOSE) return;
    const detail = err instanceof Error && err.stack ? err.stack : String(err);
    const paramLine = params === undefined ? "" : `\n  params: ${previewArgs(params)}`;
    console.error(`[modlens] error in ${context}:\n${detail}${paramLine}`);
}

/** Serialize any result to MCP text content. */
function out(result: unknown): { content: Array<{ type: "text"; text: string }> } {
    const text =
        typeof result === "string" ? result
        : Array.isArray(result) && result.every(x => typeof x === "string") ? (result as string[]).join("\n")
        : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
}

/** Coerce modId to dbId when dbId wasn't explicitly provided. */
function resolveDbId(dbId: number | undefined, modId: string | number | undefined): number | undefined {
    if (dbId != null) return dbId;
    if (modId == null) return undefined;
    const n = typeof modId === "number" ? modId : Number(modId);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Like resolveDbId, but for actions that need a valid DB id — will look up
 * string modIds via the database so agents can pass e.g. modId:"polylib".
 */
async function resolveDbIdAsync(dbId: number | undefined, modId: string | number | undefined): Promise<number | undefined> {
    if (dbId != null) return dbId;
    if (modId == null) return undefined;
    const n = typeof modId === "number" ? modId : Number(modId);
    if (Number.isFinite(n) && n > 0) return n;
    // String modId — resolve via DB lookup
    if (typeof modId === "string") {
        const mod = await resolveModRefSlim(modId);
        if (mod) return mod.id;
    }
    return undefined;
}

/** Wrap tool handler so thrown errors return an MCP error response instead of hanging. */
function safe<A extends unknown[]>(fn: (...args: A) => Promise<ReturnType<typeof out>>): (...args: A) => Promise<ReturnType<typeof out>> {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (err) {
            // Full stack + exact params go to the server log (HTTP mode / verbose);
            // the model still gets the message plus a short stack excerpt.
            const params = args[0];
            const action = params && typeof params === "object" && "action" in params
                ? `tool action=${String((params as { action: unknown }).action)}`
                : "tool call";
            logServerError(action, err, params);
            const msg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error && err.stack
                ? "\n" + err.stack.split("\n").slice(1, 4).join("\n")
                : "";
            return { content: [{ type: "text" as const, text: msg + stack }], isError: true } as ReturnType<typeof out>;
        }
    };
}

class JsonBodyParseError extends Error {}

function createMcpServer(): McpServer {
    const server = new McpServer({ name: "modlens", version: pkg.version });

// ── 1. mod ────────────────────────────────────────────────────────────────────

server.tool(
    "mod",
    "Mod database, decompile, and source browser. action=ingest|list|get|search|stats|dependencies|dep_graph|version_conflicts|source_urls|decompile|decompile_status|decompile_class|source|search_source|reindex|batch_ingest|batch_decompile|refresh_metadata|index_fts|search_indexed|index_semantic|search_semantic|get_paths|delete|graph_build|graph_status|graph_query|graph_report|graph_enrich_next|graph_enrich_submit|graph_download|graph_export|graph_submit|embed_export|embed_download|embed_download_all|embed_status|embed_submit. index_fts/search_indexed: BM25-ranked FTS over source code. index_semantic/search_semantic: vector search (requires Ollama). refresh_metadata: re-parse all mods with degraded metadata (filename/@Mod annotation) and upgrade if a higher-quality manifest is found. graph_enrich_next: get next un-enriched chunk for chat enrichment. graph_enrich_submit: submit enriched nodes/edges (chunkIndex, nodes, edges). graph_download: download pre-built graph from registry (targetType=mod|vanilla|modloader with targetId/targetVersion). graph_export: export a mod's local graph as a shareable gzipped bundle. graph_submit: (stub) community graph submission — not yet functional. embed_export/embed_download/embed_status: targetType-aware embeddings actions for mod/vanilla/modloader. embed_download: downloads registry embeddings; protects local embeddings by default (use force=true to overwrite). embed_download_all: download embeddings for all mods. embed_submit: (stub) community embedding submission — not yet functional. Auto-behaviors: decompile_status auto-queues embedding (MODLENS_AUTO_EMBED) and graph build (MODLENS_AUTO_GRAPH). Pass autoEmbed/autoGraph to override per-call.",
    {
        action: z.enum([
            "ingest","list","get","search","stats","dependencies","dep_graph",
            "version_conflicts","source_urls","decompile","decompile_status",
            "decompile_class","source","search_source","reindex","batch_ingest",
            "batch_decompile","refresh_metadata","index_fts","search_indexed","index_semantic","search_semantic","get_paths","delete",
            "graph_build","graph_status","graph_query","graph_report",
            "graph_enrich_next","graph_enrich_submit","graph_download","graph_export","graph_submit",
            "embed_export","embed_download","embed_download_all","embed_status","embed_submit",
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
        budget:       z.number().optional().describe("Token budget for graph_query (default 2000)"),
        backend:      z.string().optional().describe("Graph backend override: ollama|gemini|deepseek|openai|claude|kimi|custom|ast-only"),
        chunkIndex:   z.number().optional().describe("Chunk index for graph_enrich_submit"),
        nodes:        z.array(z.record(z.unknown())).optional().describe("Enriched nodes for graph_enrich_submit"),
        edges:        z.array(z.record(z.unknown())).optional().describe("Enriched edges for graph_enrich_submit"),
        outputDir:    z.string().optional().describe("Output directory for embed_export"),
        modVersion:   z.string().optional().describe("Mod version for embed_download"),
        targetType:   z.enum(["mod", "vanilla", "modloader"]).optional().describe("Target scope for graph/embed actions"),
        targetId:     z.string().optional().describe("Target identifier (mod id, minecraft, loader id)"),
        targetVersion:z.string().optional().describe("Target version (mod version, MC version, loader version)"),
        targetLoader: z.string().optional().describe("Optional loader hint for registry matching"),
        targetMcVersion: z.string().optional().describe("Optional MC version hint for registry matching"),
        model:        z.string().optional().describe("Embedding model override for embed_download"),
        autoEmbed:    z.boolean().optional().describe("Override auto-embed on decompile completion (default: env MODLENS_AUTO_EMBED, true)"),
        autoGraph:    z.boolean().optional().describe("Override auto-graph-build on decompile/source-download (default: env MODLENS_AUTO_GRAPH, true)"),
        provenance:   z.enum(["local", "registry", "community"]).optional().describe("Filter search_semantic results by embedding source (default: all sources)"),
    },
    safe(async ({ action, jarPath, modId, dbId: rawDbId, query, path, className, loader, mcVersion, hasMixins, decompiled, recursive, skipSource, isRegex, force, limit, directory, indexClasses, replace, budget, backend, chunkIndex, nodes, edges, outputDir, modVersion, targetType, targetId, targetVersion, targetLoader, targetMcVersion, model, autoEmbed, autoGraph, provenance }) => {
        const dbId = await resolveDbIdAsync(rawDbId, modId);
        const resolvedTargetType = targetType ?? "mod";
        const resolvedTargetId = targetId ?? (typeof modId === "string" ? modId : undefined) ?? (resolvedTargetType === "vanilla" ? "minecraft" : undefined);
        const resolvedTargetVersion = targetVersion ?? modVersion ?? (resolvedTargetType === "vanilla" ? mcVersion : undefined);
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
            case "decompile_status": result = await decompileModStatus(dbId!, { autoEmbed, autoGraph }); break;
            case "decompile_class":  result = await decompileModClass(dbId!, className!); break;
            case "source":           result = await getModSource(dbId!, path); break;
            case "search_source":    result = await searchSource(query!, dbId, isRegex ?? false, limit ?? 50); break;
            case "reindex":          result = await reindexClasses(dbId); break;
            case "batch_ingest":     result = await batchIngest(directory!, skipSource ?? true, indexClasses ?? false, replace ?? false); break;
            case "batch_decompile":  result = await batchDecompileMods({ concurrency: (limit ?? 2), autoEmbed, autoGraph }); break;
            case "refresh_metadata": result = await refreshDegradedMetadata({ loader: loader as any, mcVersion }); break;
            case "index_semantic":   result = await indexModSourceSemantic(dbId!, 50, limit); break;
            case "search_semantic":  result = await searchModSourceSemantic(query!, dbId!, limit ?? 10, provenance); break;
            case "index_fts":        result = await indexModSourceFts(dbId!); break;
            case "search_indexed":   result = await searchModSourceIndexed(dbId!, query!, limit ?? 20); break;
            case "get_paths": {
                const mod = await findModById(dbId!);
                if (!mod) throw new Error(`Mod #${dbId} not found`);
                result = {
                    dbId: mod.id,
                    modId: mod.modId,
                    version: mod.version,
                    jarPath: mod.jarPath,
                    decompPath: mod.decompPath ?? null,
                    graphPath: mod.graphPath ?? null,
                    cacheRoot: CACHE_ROOT,
                };
                break;
            }
            case "delete":           result = await deleteModFull(dbId!); break;
            case "graph_build":     result = await buildModGraph(dbId!, force ?? false, backend); break;
            case "graph_status":    result = await graphBuildStatus(dbId!); break;
            case "graph_query":     result = await queryModGraph(dbId!, query!, budget); break;
            case "graph_report":    result = await getGraphReport(dbId!); break;
            case "graph_enrich_next":   result = await enrichNextChunk(dbId!); break;
            case "graph_enrich_submit":  result = await submitEnrichment(dbId!, chunkIndex!, nodes as any, edges as any); break;
            case "graph_download":       result = await downloadGraph({
                targetType: resolvedTargetType,
                dbId,
                targetId: resolvedTargetId,
                targetVersion: resolvedTargetVersion,
                loader: targetLoader ?? loader,
                mcVersion: targetMcVersion ?? mcVersion,
            }); break;
            case "graph_export":    result = await exportGraph(dbId!, outputDir!); break;
            case "graph_submit":    result = await submitGraph({ bundlePath: outputDir ?? "" }); break;
            case "embed_export":    result = await exportEmbeddings(resolvedTargetType, outputDir!, { dbId, mcVersion: resolvedTargetVersion ?? mcVersion, targetId: resolvedTargetId }); break;
            case "embed_download":  result = await downloadEmbeddings({
                targetType: resolvedTargetType,
                targetId: resolvedTargetId,
                targetVersion: resolvedTargetVersion,
                dbId,
                model,
                force: force ?? false,
            }); break;
            case "embed_download_all": result = await downloadPackEmbeddings(); break;
            case "embed_status":    result = await getEmbedStatus({
                targetType: resolvedTargetType,
                dbId,
                mcVersion: resolvedTargetVersion ?? mcVersion,
            }); break;
            case "embed_submit":    result = await submitEmbeddings({ bundlePath: outputDir ?? "" }); break;
        }
        return out(result);
    })
);

// ── 2. mod_bytecode ───────────────────────────────────────────────────────────

server.tool(
    "mod_bytecode",
    "Mod JAR bytecode and class analysis — for INGESTED MODS only (requires dbId or modId of an ingested mod). For vanilla Minecraft classes use mc_source instead. action=search_class|class_members|bytecode|find_refs|cross_refs|inheritance|diff|diff_detailed|cache_diff|find_implementors|scan_registrations|annotated_by|event_listeners|optional_integrations|network_payloads|config_schema. Most actions require dbId or modId. cross_refs/find_implementors/annotated_by/event_listeners can omit modId to search all mods. diff/diff_detailed/cache_diff require dbIdA+dbIdB. diff_detailed gives AST-level method/field changes with breaking-change flags (add semantic=true for cosine similarity, requires mod index_semantic). cache_diff forces a (re)compute and writes to DB. Set env AUTO_CACHE_MOD_DIFFS=1 to auto-cache all diff_detailed calls.",
    {
        action:     z.enum(["search_class","class_members","bytecode","find_refs","cross_refs","inheritance","diff","diff_detailed","cache_diff","find_implementors","scan_registrations","annotated_by","event_listeners","optional_integrations","network_payloads","config_schema"]),
        dbId:      z.number().optional().describe("DB id"),
        dbIdA:     z.number().optional().describe("older DB id"),
        dbIdB:     z.number().optional().describe("newer DB id"),
        query:     z.string().optional(),
        className: z.string().optional(),
        target:    z.string().optional().describe("slash/dot class/method/field, e.g. 'Cls:meth:(I)V'"),
        annotation:z.string().optional().describe("slash/dot annotation class"),
        event:     z.string().optional().describe("slash/dot event class"),
        modId:     z.union([z.string(), z.number()]).optional().describe("Mod ID string (e.g. 'polylib') or numeric DB id. Resolved via DB lookup."),
        transitive:z.boolean().optional(),
        mcVersion: z.string().optional(),
        loader:    z.string().optional(),
        limit:     z.number().optional(),
        packages:  z.array(z.string()).optional().describe("Slash-prefix filter for diff_detailed / cache_diff"),
        semantic:  z.boolean().optional().describe("Enrich diff_detailed with Ollama cosine similarity"),
        cache:     z.boolean().optional().describe("Read from / write to DB cache for diff_detailed"),
        force:     z.boolean().optional().describe("Recompute and overwrite DB cache (implies cache=true) for diff_detailed / cache_diff"),
    },
    safe(async ({ action, dbId: rawDbId, dbIdA, dbIdB, query, className, target, annotation, event, modId, transitive, mcVersion, loader, limit, packages, semantic, cache, force }) => {
        const dbId = await resolveDbIdAsync(rawDbId, modId);
        let result: unknown;
        const autoCache = !!(process.env.AUTO_CACHE_MOD_DIFFS);
        switch (action) {
            case "search_class":     result = await searchModClass(dbId!, query!); break;
            case "class_members":    result = await getModClassMembers(dbId!, className!); break;
            case "bytecode":         result = await getModClassBytecode(dbId!, className!); break;
            case "find_refs":        result = await findModReferences(dbId!, target!); break;
            case "cross_refs":       result = await crossModRefs(target!, mcVersion, loader, limit); break;
            case "inheritance":      result = await getModInheritance(dbId!, className!); break;
            case "diff":             result = await diffModVersions(dbIdA!, dbIdB!); break;
            case "diff_detailed":    result = await diffModVersionsDetailed(dbIdA!, dbIdB!, packages, limit ?? 200, semantic ?? false, (cache ?? autoCache), force ?? false); break;
            case "cache_diff":       result = await diffModVersionsDetailed(dbIdA!, dbIdB!, packages, limit ?? 200, semantic ?? false, true, force ?? true); break;
            case "find_implementors":result = await findImplementors(target!, modId, limit, transitive); break;
            case "scan_registrations": result = await scanModRegistrations(dbId!); break;
            case "annotated_by":     result = await findAnnotatedClasses(annotation!, modId, limit); break;
            case "event_listeners":  result = await findEventListeners(event!, modId, limit); break;
            case "optional_integrations": result = await findOptionalIntegrations(dbId!); break;
            case "network_payloads": result = await findNetworkPayloads(dbId!); break;
            case "config_schema":    result = await extractConfigSchema(dbId!); break;
        }
        return out(result);
    })
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
    safe(async ({ action, modId, dbId: rawDbId, targetClass, packagePrefix, mcVersion, loader }) => {
        const dbId = await resolveDbIdAsync(rawDbId, modId);
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
    })
);

// ── 4. platform ───────────────────────────────────────────────────────────────

server.tool(
    "platform",
    "Modrinth/CurseForge platform sync and source download. action=sync_modrinth|sync_curseforge|check_updates|batch_sync|download_source|search|batch_check_updates. " +
    "action=search: unified mod search across both Modrinth and CurseForge — deduplicated, sorted by downloads (query required, loader, mcVersion, limit). " +
    "action=batch_check_updates: check ALL linked mods for newer versions on Modrinth/CurseForge in one pass (mcVersion, loader, modIdFilter, limit). " +
    "download_source downloads GitHub source without decompilation — auto-queues graph build (override with autoGraph). Env: MODLENS_AUTO_GRAPH (default: 1).",
    {
        action:          z.enum(["sync_modrinth","sync_curseforge","check_updates","batch_sync","download_source","search","batch_check_updates"]),
        dbId:            z.number().optional().describe("DB id"),
        query:           z.string().optional().describe("Search query (required for action=search)"),
        syncModrinth:    z.boolean().optional(),
        syncCurseforge:  z.boolean().optional(),
        downloadSources: z.boolean().optional(),
        modIdFilter:     z.string().optional(),
        limit:           z.number().optional(),
        loader:          z.string().optional().describe("Loader filter for search (e.g. neoforge, fabric)"),
        mcVersion:       z.string().optional().describe("MC version filter for search"),
        autoGraph:       z.boolean().optional().describe("Override auto-graph-build on source download (default: env MODLENS_AUTO_GRAPH, true)"),
    },
    safe(async ({ action, dbId: rawDbId, query, syncModrinth: sm, syncCurseforge: sc, downloadSources, modIdFilter, limit, loader, mcVersion, autoGraph }) => {
        const dbId = await resolveDbIdAsync(rawDbId, undefined);
        let result: unknown;
        switch (action) {
            case "sync_modrinth":   result = await syncModrinth(dbId!); break;
            case "sync_curseforge": result = await syncCurseforge(dbId!); break;
            case "check_updates":   result = await checkUpdates(dbId!); break;
            case "batch_sync":      result = await batchSyncSources({ syncModrinth: sm, syncCurseforge: sc, downloadSources, modIdFilter, limit }); break;
            case "download_source": { const dir = await downloadSource(dbId!, { autoGraph }); result = `Source downloaded to: ${dir}`; break; }
            case "search":          result = await searchPlatforms(query!, { loader, mcVersion, limit }); break;
            case "batch_check_updates": result = await batchCheckUpdates({ mcVersion, loader, modIdFilter, limit }); break;
        }
        return out(result);
    })
);

// ── 5. modpacks_ch ───────────────────────────────────────────────────────────

server.tool(
    "modpacks_ch",
    "Search and sync modpacks from the modpacks.ch API (a CreeperHost service) — covers FTB and CurseForge namespaces, no API key required. " +
    "action=search|featured|info|manifest|sync_pack_mods|search_ftb_mods|ftb_mod_info|download_mod|download_overrides|list_pack_versions|list_pack_files|find_mod_in_packs. " +
    "namespace=ftb|curseforge (default: ftb). " +
    "User-Agent is set per modpacks.ch (CreeperHost) team request for usage tracking.",
    {
        action:           z.enum(["search", "featured", "info", "manifest", "sync_pack_mods", "search_ftb_mods", "ftb_mod_info", "download_mod", "download_overrides", "list_pack_versions", "list_pack_files", "find_mod_in_packs"]),
        namespace:        z.enum(["ftb", "curseforge"]).optional().describe("ftb or curseforge (default: ftb)"),
        packId:           z.number().optional().describe("Pack ID (required for info, manifest, sync_pack_mods, list_pack_files)"),
        versionId:        z.number().optional().describe("Version ID (required for manifest, sync_pack_mods, list_pack_files)"),
        packVersionDbId:  z.number().optional().describe("Pack version DB id returned by sync_pack_mods (shortcut for list_pack_files)"),
        query:            z.string().optional().describe("Search query (required for search, search_ftb_mods)"),
        modId:            z.union([z.number(), z.string()]).optional().describe("FTB mod ID (required for ftb_mod_info, download_mod)"),
        fileId:           z.number().optional().describe("Exact CF file ID to download (download_mod; skips mcVersion/loader filter)"),
        loader:           z.string().optional().describe("Loader filter for ftb_mod_info/download_mod (e.g. neoforge, fabric)"),
        mcVersionFilter:  z.string().optional().describe("MC version filter for ftb_mod_info/download_mod (e.g. 26.1.2)"),
        force:            z.boolean().optional().describe("Force re-download even if cached (download_mod)"),
        modDbId:          z.number().optional().describe("ModLens DB mod id (for find_mod_in_packs)"),
        cfProject:        z.number().optional().describe("CurseForge project id (for find_mod_in_packs)"),
        fileType:         z.string().optional().describe("Filter list_pack_files by file type (e.g. mod, resource, config)"),
        limit:            z.number().optional().describe("Max results for search/featured (default: 20)"),
        fileTypes:        z.array(z.string()).optional().describe("File types to ingest (default: ['mod','resource'])"),
        skipServer:       z.boolean().optional().describe("Skip server-only files (default: false)"),
        skipOptional:     z.boolean().optional().describe("Skip optional files (default: false)"),
        concurrency:      z.number().optional().describe("Parallel downloads for sync_pack_mods (default: 3)"),
    },
    safe(async ({ action, namespace, packId, versionId, packVersionDbId, query, modId, fileId, loader, mcVersionFilter, force, modDbId, cfProject, fileType, limit, fileTypes, skipServer, skipOptional, concurrency }) => {
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
                result = await ftbModInfoAction(modId, { mcVersion: mcVersionFilter, loader });
                break;
            case "download_mod":
                if (modId === undefined) throw new Error("modId is required for action=download_mod");
                result = await downloadModAction(modId, { mcVersion: mcVersionFilter, loader, fileId, force });
                break;
            case "list_pack_versions":
                result = await listPackVersionsAction(namespace, packId);
                break;
            case "list_pack_files":
                result = await listPackFilesAction({ packVersionDbId, namespace, packId, versionId, fileType });
                break;
            case "download_overrides":
                if (!packId)    throw new Error("packId is required for action=download_overrides");
                if (!versionId) throw new Error("versionId is required for action=download_overrides");
                result = await downloadOverridesAction({ namespace: ns, packId, versionId, force });
                break;
            case "find_mod_in_packs":
                if (modDbId === undefined && cfProject === undefined)
                    throw new Error("Provide modDbId or cfProject for action=find_mod_in_packs");
                result = await findModInPacksAction({ modDbId, cfProject });
                break;
        }
        return out(result);
    }),
);

// ── 6. mc_versions ────────────────────────────────────────────────────────────

server.tool(
    "mc_versions",
    "Minecraft and mod loader version management. action=list_mc|list_neoforge|list_forge|list_fabric|ingest_neoforge|ingest_forge|ingest_fabric.",
    {
        action:    z.enum(["list_mc","list_neoforge","list_forge","list_fabric","ingest_neoforge","ingest_forge","ingest_fabric"]),
        type:      z.enum(["release","snapshot","all"]).optional(),
        mcVersion: z.string().optional(),
        version:   z.string().optional(),
        skipIndex: z.boolean().optional(),
        limit:     z.number().optional(),
    },
    safe(async ({ action, type, mcVersion, version, skipIndex, limit }) => {
        let result: unknown;
        switch (action) {
            case "list_mc": {
                const mcVersions = await listMcVersions(type ?? "release");
                result = limit ? mcVersions.slice(0, limit) : mcVersions;
                break;
            }
            case "list_neoforge":result = await listNeoForgeVersions(mcVersion, limit ?? 20); break;
            case "list_forge":  result = await listForgeVersions(mcVersion, limit ?? 20); break;
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
            case "ingest_forge": {
                const jarPath = await downloadForge(version!, mcVersion);
                const r = await ingestMod(jarPath, true) as any;
                if (r.status === "already_ingested") { result = `Already ingested. DB id: ${r.mod.id}`; break; }
                if (!skipIndex) await reindexClasses(r.mod.id);
                result = { ...r, jarPath };
                break;
            }
        }
        return out(result);
    })
);

// ── 6. mc_source ─────────────────────────────────────────────────────────────

server.tool(
    "mc_source",
    "Vanilla Minecraft source code, decompilation, and validation — use this for vanilla MC classes (net/minecraft/...), NOT mod_bytecode. Requires version param. action=search_class|get_source|bytecode|class_members|find_refs|inheritance|diff|diff_detailed|decompile|decompile_status|search_code|index|search_indexed|search_events|validate_aw|analyze_mixin|index_semantic|search_semantic|get_paths. get_paths returns the on-disk jar, decompiled source directory, and index paths so the agent can grep/search files natively. diff_detailed gives AST-level method/field changes with breaking-change flags per class; add semantic=true for cosine similarity scoring (requires Ollama + index_semantic run first). index_semantic/search_semantic require Ollama running.",
    {
        action:     z.enum(["search_class","get_source","bytecode","class_members","find_refs","inheritance","diff","diff_detailed","decompile","decompile_status","search_code","index","search_indexed","search_events","validate_aw","analyze_mixin","index_semantic","search_semantic","get_paths"]),
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
        packages:   z.array(z.string()).optional().describe("Slash-prefix filter for diff_detailed, e.g. ['net/minecraft/world/entity']"),
        semantic:   z.boolean().optional().describe("Enrich diff_detailed with Ollama cosine similarity (requires Ollama + index_semantic)"),
        cache:      z.boolean().optional().describe("Read/write DB cache for diff_detailed (default true; set false to skip cache)"),
        modloader:  z.enum(["minecraft","neoforge","forge","fabric","fabric-api"]).optional(),
        content:    z.string().optional().describe("Full .accesswidener file text (validate_aw)"),
        source:     z.string().optional().describe("Full mixin Java source code (analyze_mixin)"),
        startLine:  z.number().optional().describe("1-based start line"),
        endLine:    z.number().optional().describe("1-based end line"),
        maxLines:   z.number().optional(),
        limit:      z.number().optional(),
        provenance: z.enum(["local", "registry", "community"]).optional().describe("Filter search_semantic results by embedding source (default: all sources)"),
    },
    safe(async ({ action, version, versionA, versionB, mcVersion, query, className, target, searchType, isRegex, force, packages, semantic, cache, modloader, content, source, startLine, endLine, maxLines, limit, provenance }) => {
        const v = version ?? mcVersion;
        let result: unknown;
        switch (action) {
            case "search_class":    result = await searchMinecraftClass(v!, query!); break;
            case "get_source":      result = await getMinecraftSource(v!, className!, startLine, endLine, maxLines); break;
            case "bytecode":        result = await getMcClassBytecode(v!, className!); break;
            case "class_members":   result = await getMcClassMembers(v!, className!); break;
            case "find_refs":       result = await findMcReferences(v!, target!); break;
            case "inheritance":     result = await getMcInheritance(v!, className!); break;
            case "diff":            result = await diffMcVersions(versionA!, versionB!); break;
            case "diff_detailed":   result = await diffMcVersionsDetailed(versionA!, versionB!, packages, limit ?? 200, force ?? false, semantic ?? false, cache ?? true); break;
            case "decompile":       result = await decompileMcVersion(v!, force ?? false); break;
            case "decompile_status":result = await decompileMcVersionStatus(v!); break;
            case "search_code":     result = await searchMcCode(v!, query!, searchType ?? "content", isRegex ?? false, limit ?? 50); break;
            case "index":           result = await indexMcVersion(v!, force ?? false); break;
            case "search_indexed":  result = await searchMcIndexed(query!, v!, limit ?? 20); break;
            case "search_events":   result = await searchEvents(v!, query, modloader as any); break;
            case "validate_aw":     result = await validateAccessWidener(content!, v!); break;
            case "analyze_mixin":   result = await analyzeMixin(source!, v!); break;
            case "index_semantic":  result = await indexMcSourceSemantic(v!, (limit as number | undefined) ?? 50); break;
            case "search_semantic": result = await searchMcSourceSemantic(query!, v!, limit ?? 10, provenance); break;
            case "get_paths": {
                const ver = v!;
                result = {
                    version: ver,
                    jarPath:      mcPaths.jar(ver),
                    decompPath:   mcPaths.decompiled(ver),
                    indexPath:    mcPaths.index(ver),
                    cacheRoot:    CACHE_ROOT,
                };
                break;
            }
        }
        return out(result);
    })
);

// ── 7. mappings ───────────────────────────────────────────────────────────────

server.tool(
    "mappings",
    "Minecraft name mappings (official/intermediary/yarn/mojmap) and Parchment parameter docs. action=find|remap|parchment|list_parchment|parchment_summary.",
    {
        action:    z.enum(["find","remap","parchment","list_parchment","parchment_summary"]),
        symbol:    z.string().optional().describe("symbol to translate"),
        version:   z.string().optional(),
        sourceNs:  z.enum(["official","intermediary","yarn","mojmap","srg","mcp"]).optional().describe("Allowed: official, intermediary, yarn, mojmap, srg, mcp"),
        targetNs:  z.enum(["official","intermediary","yarn","mojmap","srg","mcp"]).optional().describe("Allowed: official, intermediary, yarn, mojmap, srg, mcp"),
        inputJar:  z.string().optional(),
        outputJar: z.string().optional(),
        toMapping: z.enum(["yarn","mojmap"]).optional(),
        className: z.string().optional(),
        mcVersion: z.string().optional(),
    },
    safe(async ({ action, symbol, version, sourceNs, targetNs, inputJar, outputJar, toMapping, className, mcVersion }) => {
        const v = version ?? mcVersion;
        const mv = mcVersion ?? version;
        let result: unknown;
        switch (action) {
            case "find":              result = await findMapping(symbol!, v!, sourceNs!, targetNs!); break;
            case "remap":             result = await remapModJar(inputJar!, outputJar!, v!, toMapping!); break;
            case "parchment":         result = await getParchment(className!, mv!); break;
            case "list_parchment":    result = await listParchmentVersions(mv!); break;
            case "parchment_summary": result = await getParchmentSummary(mv!); break;
        }
        return out(result);
    })
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
    safe(async ({ action, entries, query, category, namespace, tag, id, limit }) => {
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
    })
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
    safe(async ({ action, entries, id, fromVersion, toVersion, modloader, query, limit }) => {
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
    })
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
    safe(async ({ action, version, registry, filter }) => {
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
    })
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
    safe(async ({ action, version, registry, tagId, namespace, entry, type, outputItem, recipeId, item, category, path, filter, block, modelPath, resolveParents, biomeId, id, entity, modId, limit }) => {
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
    })
);

// ── 12. mc_files ─────────────────────────────────────────────────────────────

server.tool(
    "mc_files",
    "Vanilla MC file access via misode/mcmeta (data packs, assets, atlases, diffs, changelogs). action=get_data|get_asset|list_files|diff|atlas|raw|compare|changelog. list_files requires dirPath+version+branch. diff requires filePath+versionA+versionB. get_data/get_asset require filePath.",
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
    safe(async ({ action, filePath, version, versionA, versionB, branch, dirPath, jsonOnly, atlas, ref }) => {
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
    })
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
    safe(async ({ action, modId, prefix, path, filter, namespace, atlas, type, limit }) => {
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
    })
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
    safe(async ({ action, type, modId, dbIdA, dbIdB, itemId, maxDepth, id, modelPath, namespace, filter, registry, dataType }) => {
        let result: unknown;
        if (action === "diff") {
            result = await diffModData(dbIdA!, dbIdB!, dataType);
        } else if (action === "trace_item") {
            result = await traceRecipeChain(itemId!, maxDepth);
        } else if (action === "list") {
            switch (type) {
                case "data_tag":    result = await listModDataTags(modId!, registry, namespace, filter); break;
                default:            result = await listModData(modId!, type, { namespace, filter }) ; break;
            }
        } else {
            switch (type) {
                case "model":       result = await getModModel(modId!, modelPath ?? id!, namespace); break;
                case "data_tag":    result = await getModDataTag(modId!, registry!, id!, namespace); break;
                default:            result = await getModData(modId!, type, id!, { namespace }); break;
            }
        }
        return out(result);
    })
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
    safe(async ({ action, modId, tagPath, registry, query, maxDepth, limit }) => {
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
    })
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
    safe(async ({ action, loader, mcVersion, minConflicts, targetClass, top }) => {
        let result: unknown;
        switch (action) {
            case "list_mods":       result = await listModsWithMixins(loader, mcVersion); break;
            case "conflict_matrix": result = await getMixinConflictMatrix(loader, mcVersion, minConflicts); break;
            case "class_detail":    result = await getMixinClassDetail(targetClass!); break;
            case "hotspots":        result = await getMixinHotspots(top, loader); break;
            case "batch_resolve":   result = await batchResolveMixins(loader, mcVersion); break;
        }
        return out(result);
    })
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
    safe(async ({ action, modId, query, modIdFilter, groupFilter, limit }) => {
        let result: unknown;
        switch (action) {
            case "get_files":    result = await getModGradleFiles(modId!); break;
            case "search":       result = await searchGradleFiles(query!, modIdFilter, limit); break;
            case "compare_deps": result = await compareGradleDeps(groupFilter, modIdFilter); break;
        }
        return out(result);
    })
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
    safe(async ({ report, savePath, modId, loader, mcVersion, registry, minConflicts, groupFilter, modIdFilter, dbIds, oldIds, newIds }) => {
        const result = await generateReport({ report, savePath, modId, loader, mcVersion, registry, minConflicts, groupFilter, modIdFilter, dbIds, oldIds, newIds });
        return out(result.savedTo ? `Saved to: ${result.savedTo}\n\n${result.markdown}` : result.markdown);
    })
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
    "action=data_conflicts: find data/ paths (recipes, loot_tables, advancements, etc.) shipped by 2+ mods \u2014 last-loaded mod silently wins (dataType, mcVersion, loader, limit). " +
    "action=pack_graph: build a composite knowledge graph of the entire modpack \u2014 nodes (mods, tags, MC classes, KubeJS scripts) and edges (depends_on, mixes_into, contributes_tag, tag_conflict, script_modifies). Includes hub detection and mixin hotspots (mcVersion, loader, scriptsDir). " +
    "action=config_diff: compare a modpack's on-disk config/ directory against default configs bundled in mod JARs \u2014 identifies modified, unchanged, custom, and missing configs (configDir required, mcVersion, loader). " +
    "action=health: one-shot modpack health overview \u2014 mod count, loader breakdown, missing deps, mixin hotspots, tag conflicts, platform link stats (mcVersion, loader).",
    {
        action:      z.enum(["asset_conflicts","vanilla_overrides","sidedness","pack_sidedness","complexity","pack_changelog","data_conflicts","pack_graph","config_diff","health"]),
        modId:       z.union([z.string(), z.number()]).optional(),
        assetType:   z.enum(["textures","models","sounds","blockstates","shaders","all"]).optional().describe("Asset sub-folder filter (asset_conflicts)"),
        dataType:    z.enum(["recipe","loot_tables","advancements","tags","structures","all"]).optional().describe("Data sub-folder filter (data_conflicts)"),
        overrideType:z.enum(["data","assets","all"]).optional().describe("Override type filter (vanilla_overrides)"),
        dataSubtype: z.string().optional().describe("Data subfolder, e.g. 'recipes', 'loot_tables', 'advancements' (vanilla_overrides)"),
        scriptsDir:  z.string().optional().describe("Absolute path to kubejs/ folder for pack_graph KubeJS integration"),
        configDir:   z.string().optional().describe("Absolute path to the modpack's config/ directory (config_diff)"),
        mcVersion:   z.string().optional(),
        loader:      z.string().optional(),
        oldIds:      z.array(z.number()).optional(),
        newIds:      z.array(z.number()).optional(),
        limit:       z.number().optional(),
    },
    safe(async ({ action, modId, assetType, dataType, overrideType, dataSubtype, scriptsDir, configDir, mcVersion, loader, oldIds, newIds, limit }) => {
        let result: unknown;
        switch (action) {
            case "asset_conflicts":   result = await findAssetConflicts(assetType, mcVersion, loader, limit); break;
            case "vanilla_overrides": result = await findVanillaOverrides(overrideType, dataSubtype, mcVersion, loader); break;
            case "sidedness":         result = await analyzeModSidedness(modId!); break;
            case "pack_sidedness":    result = await analyzePackSidedness(mcVersion, loader); break;
            case "complexity":        result = await computeModComplexity(mcVersion, loader); break;
            case "pack_changelog":    result = await computePackChangelog(oldIds!, newIds!); break;
            case "data_conflicts":    result = await findDataConflicts(dataType, mcVersion, loader, limit); break;
            case "pack_graph":        result = await buildPackGraph(mcVersion, loader, scriptsDir); break;
            case "config_diff":       result = await diffPackConfigs(configDir!, mcVersion, loader); break;
            case "health":            result = await packHealth(mcVersion, loader); break;
        }
        return out(result);
    })
);

// ── 21. kubejs ────────────────────────────────────────────────────────────────

server.tool(
    "kubejs",
    "KubeJS script analysis \u2014 index a kubejs/ directory or text-search scripts. action=index|search|semantic_search. semantic_search requires Ollama running.",
    {
        action:     z.enum(["index","search","semantic_search"]),
        scriptsDir: z.string().describe("Absolute path to the kubejs/ folder or a subfolder like kubejs/server_scripts/"),
        query:      z.string().optional(),
        limit:      z.number().optional(),
    },
    safe(async ({ action, scriptsDir, query, limit }) => {
        let result: unknown;
        switch (action) {
            case "index":           result = await indexKubeJsScripts(scriptsDir); break;
            case "search":          result = await searchKubeJsScripts(scriptsDir, query!, limit); break;
            case "semantic_search": result = await semanticSearchKubeJsScripts(scriptsDir, query!, limit); break;
        }
        return out(result);
    })
);

// ── 22. analyze_crash_log ────────────────────────────────────────────────────

server.tool(
    "analyze_crash_log",
    "Parse a NeoForge/Forge/Fabric crash log and return suspect mods ranked by stack-frame hits against the indexed class DB.",
    {
        logText: z.string().describe("full crash log text"),
    },
    safe(async ({ logText }) => {
        const result = await analyzeCrashLog(logText);
        return out(result);
    })
);

// ── 23. find_missing_deps ────────────────────────────────────────────────────

server.tool(
    "find_missing_deps",
    "Find declared mod dependencies not satisfied by any ingested mod in the DB. Skips loader pseudo-deps (minecraft, neoforge, java, etc.).",
    {
        mcVersion: z.string().optional(),
        loader:    z.string().optional().describe("neoforge|forge|fabric|quilt"),
    },
    safe(async ({ mcVersion, loader }) => {
        const result = await findMissingDeps(mcVersion, loader);
        return out(result);
    })
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
    safe(async ({ jarPath, mcVersion, loader }) => {
        const result = await checkModCompat(jarPath, mcVersion, loader);
        return out(result);
    })
);

    return server;
}

// ── Start ─────────────────────────────────────────────────────────────────────

process.on("SIGINT", async () => { await disconnect(); process.exit(0); });
process.on("SIGTERM", async () => { await disconnect(); process.exit(0); });

// Transport selection:
//   • MCP_PORT set  → Streamable HTTP transport (for k8s / remote deployments).
//   • otherwise     → stdio transport (default, local CLI use).
const httpPort = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : null;

if (httpPort && !Number.isNaN(httpPort)) {
    await startHttpServer(httpPort);
} else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// Background: re-queue any mods that were partially embedded before this start
// Set MODLENS_AUTO_EMBED=0 to disable.
if (process.env.MODLENS_AUTO_EMBED !== "0") {
    startupEmbedScan().catch(() => {});
}

/**
 * Streamable HTTP transport with per-session state.
 *
 * - POST /mcp           → client→server messages. A request with no session id
 *                          and an `initialize` body opens a new session.
 * - GET  /mcp           → server→client SSE stream for an existing session.
 * - DELETE /mcp         → explicit session teardown.
 * - GET  /healthz       → liveness/readiness probe (k8s).
 *
 * Bind path is configurable via MCP_PATH (default "/mcp"). Set MCP_HOST to
 * change the bind address (default 0.0.0.0).
 */
async function startHttpServer(port: number): Promise<void> {
    const mcpPath = process.env.MCP_PATH ?? "/mcp";
    const host = process.env.MCP_HOST ?? "0.0.0.0";

    // Active sessions keyed by Mcp-Session-Id header.
    const transports = new Map<string, StreamableHTTPServerTransport>();

    const readBody = (req: IncomingMessage): Promise<unknown> =>
        new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c as Buffer));
            req.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                if (!raw) return resolve(undefined);
                try { resolve(JSON.parse(raw)); }
                catch { reject(new JsonBodyParseError("Invalid JSON request body")); }
            });
            req.on("error", reject);
        });

    const sendJson = (res: ServerResponse, status: number, body: unknown) => {
        const payload = JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload);
    };

    const isInitialize = (body: unknown): boolean => {
        const messages = Array.isArray(body) ? body : [body];
        return messages.length === 1 && isInitializeRequest(messages[0]);
    };

    const getHeader = (req: IncomingMessage, name: string): string | undefined => {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
    };

    const httpServer = createHttpServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

        if (url.pathname === "/healthz") {
            return sendJson(res, 200, { status: "ok" });
        }

        if (url.pathname !== mcpPath) {
            return sendJson(res, 404, { error: "not found" });
        }

        const sessionId = getHeader(req, "mcp-session-id");

        try {
            // Existing session — route to its transport.
            if (sessionId) {
                const transport = transports.get(sessionId);
                if (!transport) {
                    return sendJson(res, 404, {
                        jsonrpc: "2.0",
                        error: { code: -32001, message: "Session not found" },
                        id: null,
                    });
                }
                const body = req.method === "POST" ? await readBody(req) : undefined;
                await transport.handleRequest(req, res, body);
                return;
            }

            // New session — must be an initialize POST.
            if (req.method === "POST") {
                const body = await readBody(req);
                if (!isInitialize(body)) {
                    return sendJson(res, 400, {
                        jsonrpc: "2.0",
                        error: { code: -32000, message: "No valid session ID provided" },
                        id: null,
                    });
                }
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => { transports.set(id, transport); },
                });
                transport.onclose = () => {
                    if (transport.sessionId) transports.delete(transport.sessionId);
                };
                const server = createMcpServer();
                await server.connect(transport);
                await transport.handleRequest(req, res, body);
                return;
            }

            return sendJson(res, 400, {
                jsonrpc: "2.0",
                error: { code: -32000, message: "No valid session ID provided" },
                id: null,
            });
        } catch (err) {
            if (!res.headersSent) {
                if (err instanceof JsonBodyParseError) {
                    return sendJson(res, 400, {
                        jsonrpc: "2.0",
                        error: { code: -32700, message: "Parse error: Invalid JSON" },
                        id: null,
                    });
                }
                sendJson(res, 500, {
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
            logServerError(`http ${req.method} ${url.pathname}`, err);
        }
    });

    await new Promise<void>((resolve) => {
        httpServer.listen(port, host, () => {
            console.error(`modlens-mcp listening on http://${host}:${port}${mcpPath}`);
            console.error(`[modlens] verbose logging ${VERBOSE ? "ON" : "OFF"} (set MODLENS_VERBOSE=0 to silence, =1 to force on)`);
            resolve();
        });
    });
}
