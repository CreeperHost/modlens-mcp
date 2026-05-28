/**
 * modlens CLI — command-line interface for all modlens-mcp operations.
 * Usage: node dist/cli.js <command> [args] [--flags]
 *        Run without arguments to see all commands.
 */
import { ingestMod, decompileMod, decompileModStatus, reindexClasses, batchIngest, batchDecompileMods } from "./tools/ingest.js";
import { listMods, getModDetails, searchMods, getDbStats, getDependencies, findVersionConflicts, getDependencyGraph, listModSourceUrls, listModRegistryEntries } from "./tools/catalog.js";
import { getModSource, searchSource, decompileModClass } from "./tools/source.js";
import {
    searchModClass, getModClassMembers, getModClassBytecode,
    findModReferences, getModInheritance, diffModVersions,
    crossModRefs, findImplementors, scanModRegistrations, findAnnotatedClasses,
    findEventListeners, findOptionalIntegrations, findNetworkPayloads, extractConfigSchema,
} from "./tools/bytecode.js";
import {
    getMixinTargets, getMixinConflicts, getAtEntries, getAwEntries, resolveMixinTargets,
    getMixinsTargetingPackage, findAtAwConflicts,
    listModsWithMixins, getMixinConflictMatrix, getMixinClassDetail, getMixinHotspots, batchResolveMixins,
} from "./tools/mixin-scan.js";
import { syncModrinth, syncCurseforge, checkUpdates, downloadSource, batchSyncSources } from "./tools/platform.js";
import {
    listMcVersions, listNeoForgeVersions, listFabricApiVersions, listForgeVersions,
    downloadNeoForge, downloadFabricApi, downloadForge,
} from "./platform.js";
import {
    searchMinecraftClass, getMinecraftSource, getMcClassBytecode, getMcClassMembers,
    findMcReferences, getMcInheritance, diffMcVersions,
    decompileMcVersion, decompileMcVersionStatus, searchMcCode,
    validateAccessWidener, analyzeMixin, searchEvents,
} from "./tools/vanilla.js";
import { diffMcVersionsDetailed, diffModVersionsDetailed } from "./tools/version-diff.js";
import {
    indexMcVersion, searchMcIndexed, indexMcSourceSemantic, searchMcSourceSemantic,
    indexModSourceFts, indexModSourceSemantic, searchModSourceIndexed, searchModSourceSemantic,
} from "./tools/mc-fts.js";
import { findMapping, remapModJar, getParchment, listParchmentVersions, getParchmentSummary } from "./tools/mappings.js";
import {
    ingestDocumentation, getDocumentation, searchDocumentation, listDocumentation,
    deleteDocumentation, seedDefaultDocumentation, semanticSearchDocumentation, backfillDocEmbeddings,
} from "./tools/docs.js";
import {
    ingestPrimer, getPrimer, getPrimersByVersionRange, searchPrimers, listPrimers,
    deletePrimer, seedDefaultPrimers, semanticSearchPrimers, backfillPrimerEmbeddings,
} from "./tools/primers.js";
import {
    getMcmetaVersions, getMcBlocks, getMcCommands, getMcRegistries, getMcSounds, getMcItemComponents,
    getMcDataFile, getMcAssetFile, listMcDataFiles, diffMcData, getMcAtlas, getMcmetaRaw, getRegistryEntries,
    compareVersions, getVersionChangelog,
} from "./tools/mcmeta.js";
import {
    getMcTags, findTagsForEntry, listRecipes, getRecipe, findRecipesForItem,
    listLootTables, getLootTable, getLangEntries, getBlockstate, getMcModel, getModelTree,
    listBiomes, getBiome, listDamageTypes, listEnchantments, getEnchantment,
    listAdvancements, getAdvancement, listStructures, getStructureData,
    getMcParticles, getParticleData, getEntityAttributes,
} from "./tools/vanilla-data.js";
import {
    indexModTags, indexAllModTags, listTagNamespaces, getTagContributors,
    getModTagList, findTagConflicts, searchModTags, expandTag,
} from "./tools/mod-tags.js";
import { getModGradleFiles, searchGradleFiles, compareGradleDeps } from "./tools/gradle.js";
import { generateReport } from "./tools/reports.js";
import { findAssetConflicts, findVanillaOverrides, analyzeModSidedness, analyzePackSidedness, computeModComplexity, computePackChangelog, findDataConflicts } from "./tools/packtools.js";
import { indexKubeJsScripts, searchKubeJsScripts } from "./tools/kubejs.js";
import {
    searchPacksAction, featuredPacksAction, packInfoAction, packManifestAction, syncPackModsAction,
    searchFtbModsAction, ftbModInfoAction, downloadModAction, downloadOverridesAction,
    listPackVersionsAction, listPackFilesAction, findModInPacksAction,
} from "./tools/modpacks-ch.js";
import { analyzeCrashLog, findMissingDeps } from "./tools/diagnostics.js";
import { checkModCompat } from "./tools/compat-check.js";
import {
    listModJarFiles, getModJarFile, getModLang, getModSounds, getModAtlas,
    getModManifest, listModConfigs, getModConfig,
    listModData, getModData, listModDataTags, getModDataTag, getModModel as getModModelData,
    diffModData, traceRecipeChain,
} from "./tools/mod-data.js";
import { mcPaths } from "./minecraft.js";
import { findModById } from "./repositories/mod.js";
import { CACHE_ROOT } from "./cache.js";
import { getDb, disconnect } from "./db.js";
import { readdir, readFile } from "fs/promises";
import { join, resolve } from "path";

// ── Arg parsing ──────────────────────────────────────────────────────────────

const [,, command, ...rest] = process.argv;

function parseArgs(args: string[]) {
    const flags: Record<string, string | boolean | number> = {};
    const positional: string[] = [];
    for (const arg of args) {
        if (arg.startsWith("--")) {
            const eq = arg.indexOf("=");
            if (eq !== -1) {
                const key = toCamel(arg.slice(2, eq));
                const raw = arg.slice(eq + 1);
                flags[key] = raw !== "" && !isNaN(Number(raw)) ? Number(raw) : raw;
            } else {
                flags[toCamel(arg.slice(2))] = true;
            }
        } else {
            positional.push(arg);
        }
    }
    return { flags, positional };
}

function toCamel(s: string) {
    return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function out(data: unknown) {
    console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function die(msg: string): never {
    console.error(`Error: ${msg}`);
    process.exit(1);
}

function requireArg(val: string | undefined, name: string): string {
    if (!val) die(`<${name}> is required`);
    return val!;
}

function numArg(val: string | undefined, name: string): number {
    const n = Number(val);
    if (!val || isNaN(n)) die(`<${name}> must be a number`);
    return n;
}

function modIdArg(val: string | undefined, name: string): string | number {
    const s = requireArg(val, name);
    const n = Number(s);
    return isNaN(n) ? s : n;
}

// ── Help ─────────────────────────────────────────────────────────────────────

const HELP = `
modlens CLI — analyze Minecraft mod JARs

Usage: node dist/cli.js <command> [args] [--flags]

DATABASE & CATALOG
  stats                              DB statistics (mod count, classes, loaders)
  list                               List all mods
                                     [--loader=] [--mc-version=] [--has-mixins] [--decompiled] [--limit=50]
  get <modId|dbId>                   Get full metadata for a mod
  search <query>                     Search mods by name/id  [--loader=] [--mc-version=] [--limit=20]
  deps <modId|dbId>                  List mod dependencies  [--recursive]

INGEST
  ingest <jarPath>                   Ingest a mod JAR  [--skip-source] [--skip-index]
  ingest-neoforge <version>          Download + ingest NeoForge (e.g. 21.1.228)  [--skip-index]
  ingest-forge <version>             Download + ingest Forge (e.g. 1.20.1-47.3.22)  [--skip-index]
  ingest-fabric-api <version>        Download + ingest Fabric API (e.g. 0.116.11+1.21.1)  [--skip-index]
  batch-ingest <dir>                 Ingest all JARs in a directory  [--index]
  reindex                            Index class names for un-indexed mods  [--db-id=N]

DECOMPILE & SOURCE
  decompile <dbId>                   Decompile entire mod JAR with Vineflower
  decompile-class <dbId> <class>     Decompile a single class (faster)
  source <dbId> [path]               Browse or read decompiled source
  search-source <query>              Search decompiled source  [--db-id=N] [--regex] [--limit=50]

BYTECODE ANALYSIS
  search-class <dbId> <query>        Search for a class by name
  members <dbId> <class>             List methods and fields of a class
  bytecode <dbId> <class>            Raw javap bytecode for a class
  refs <dbId> <target>               Find references to a class/method/field
  inheritance <dbId> <class>         Superclass, interfaces, subclasses
  diff <dbIdA> <dbIdB>               Compare two mod versions (added/removed classes)

MIXIN ANALYSIS
  mixin-targets <modId|dbId>         MC classes this mod injects into
  resolve-mixins <dbId>              Parse @Mixin bytecode and update DB targets
  mixin-conflicts <targetClass>      All mods injecting into the same MC class
  at-entries <dbId>                  Access Transformer entries
  aw-entries <dbId>                  Access Widener entries

PLATFORM
  sync-modrinth <dbId>               Look up mod on Modrinth
  sync-curseforge <dbId>             Look up mod on CurseForge
  check-updates <dbId>               Check for newer versions
  download-source <dbId>             Download GitHub/GitLab source

VERSIONS
  mc-versions                        List Minecraft versions  [--type=release|snapshot|all]
  neoforge-versions                  List NeoForge versions  [--mc-version=1.21.1] [--limit=20]
  fabric-api-versions                List Fabric API versions  [--mc-version=1.21.1] [--limit=20]

BATCH
  batch-resolve-mixins               Resolve @Mixin targets for all mixin mods

MOD: ADDITIONAL ACTIONS
  dep-graph                          Dependency graph for all ingested mods  [--mc-version=]
  version-conflicts                  Find mods with conflicting version requirements
  source-urls [query]                List Modrinth/CurseForge source URLs (filter by query)
  decompile-status <dbId>            Decompilation progress for a mod
  batch-decompile                    Decompile all un-decompiled mods  [--concurrency=2]
  get-paths <dbId>                   JAR/decomp paths so you can grep natively
  batch-sync                         Batch sync all mods from platform APIs
                                     [--sync-modrinth] [--sync-curseforge] [--download-sources]
                                     [--mod-id-filter=] [--limit=]

MOD BYTECODE: ADVANCED
  cross-refs <target>                Cross-mod references to a class/method/field
                                     [--mc-version=] [--loader=] [--limit=]
  diff-detailed <dbIdA> <dbIdB>      AST-level method/field diff with breaking-change flags
                                     [--packages=a/b,c/d] [--limit=200] [--semantic] [--cache] [--force]
  find-implementors <target>         Find all classes implementing an interface/extending a class
                                     [--mod-id=] [--limit=] [--transitive]
  scan-registrations <dbId>          Scan mod for registry object registrations
  annotated-by <annotation>          Find classes annotated with a given annotation  [--mod-id=] [--limit=]
  event-listeners <event>            Find event listener registrations  [--mod-id=] [--limit=]
  optional-integrations <dbId>       Detect optional mod integrations (soft dependencies)
  network-payloads <dbId>            Extract network packet/payload types
  config-schema <dbId>               Extract configuration class schemas

MIXIN ANALYSIS: ADVANCED
  targets-in-package <packagePrefix> All mods targeting a class within a package  [--mc-version=]
  at-conflicts                       AT/AW entries conflicting across mods  [--mc-version=] [--loader=]

MIXIN SCAN (cross-mod conflict matrix)
  mixin-scan list                    List mods with mixins  [--loader=] [--mc-version=]
  mixin-scan conflict-matrix         Full mixin conflict matrix  [--loader=] [--mc-version=] [--min-conflicts=]
  mixin-scan class-detail <class>    All mixins targeting a single MC class
  mixin-scan hotspots                Most-targeted MC classes  [--top=N] [--loader=]
  mixin-scan batch-resolve           Resolve mixin targets for all mods  [--loader=] [--mc-version=]

VANILLA MC SOURCE
  mc-source search-class <ver> <q>   Search for a vanilla class by name
  mc-source get-source <ver> <class> Get decompiled vanilla source  [--start-line=] [--end-line=] [--max-lines=]
  mc-source bytecode <ver> <class>   Raw javap bytecode for a vanilla class
  mc-source class-members <ver> <c>  Methods and fields of a vanilla class
  mc-source find-refs <ver> <target> References to a class/method/field in vanilla
  mc-source inheritance <ver> <c>    Inheritance tree for a vanilla class
  mc-source diff <verA> <verB>       High-level diff between two MC versions
  mc-source diff-detailed <A> <B>    AST-level method/field diff  [--packages=] [--limit=200] [--semantic] [--cache] [--force]
  mc-source decompile <ver>          Decompile MC version with Vineflower  [--force]
  mc-source decompile-status <ver>   Check decompilation progress
  mc-source search-code <ver> <q>    Full-text search over vanilla source  [--search-type=content|class|method|field|all] [--regex] [--limit=50]
  mc-source index <ver>              Index vanilla source for BM25 search  [--force]
  mc-source search-indexed <ver> <q> BM25-ranked FTS over vanilla source  [--limit=20]
  mc-source search-events <ver>      Browse event classes  [query]  [--modloader=minecraft|neoforge|fabric|fabric-api]
  mc-source validate-aw <ver> <file> Validate an .accesswidener file against vanilla
  mc-source analyze-mixin <ver> <f>  Analyze a mixin Java source file
  mc-source search-semantic <ver> <q> Semantic search (requires Ollama + index)  [--limit=10]
  mc-source get-paths <ver>          On-disk jar/decomp/index paths

MAPPINGS
  mappings find <sym> <ver> <src> <tgt>  Translate symbol between namespaces (official|intermediary|yarn|mojmap)
  mappings remap <in.jar> <out.jar> <ver> <mapping>  Remap a JAR between namespaces
  mappings parchment <class> <mcVersion>  Parchment parameter/javadoc for a class
  mappings list-parchment <mcVersion>     Available Parchment versions
  mappings parchment-summary <mcVersion>  Stats on Parchment coverage

DOCS
  docs seed                          Seed built-in documentation entries
  docs get <query>                   Get documentation by title/class
  docs search <query>                Keyword search  [--category=] [--namespace=]
  docs list                          List all docs  [--category=] [--namespace=] [--tag=] [--limit=100]
  docs delete <id>                   Delete a doc entry by ID
  docs semantic-search <query>       Semantic search (requires Ollama)  [--limit=10]

PRIMERS (version migration guides)
  primers seed                       Seed built-in porting primers
  primers get <id>                   Get primer by ID
  primers by-version <from> <to>     Get primers for a version range  [--modloader=]
  primers search <query>             Keyword search  [--modloader=] [--limit=]
  primers list                       List all primers  [--modloader=] [--limit=]
  primers delete <id>                Delete a primer by ID
  primers semantic-search <query>    Semantic search (requires Ollama)  [--limit=10]

MC REGISTRY
  mc-registry blocks                 Vanilla block list  [--version=]
  mc-registry commands               Vanilla command tree  [--version=]
  mc-registry registries             Registry keys  [--version=] [--registry=]
  mc-registry sounds                 Sound event list  [--version=]
  mc-registry item-components        Item component types  [--version=]
  mc-registry registry-entries <reg> Entries in a registry  [--version=]
  mc-registry mcmeta-versions        Versions index  [--filter=release|snapshot|all]

MC DATA
  mc-data tags                       Vanilla data tags  [--version=] [--registry=] [--tag-id=] [--namespace=]
  mc-data find-tags-for <entry>      Tags containing an entry  --registry=  [--version=] [--namespace=]
  mc-data recipes                    Recipe list  [--version=] [--type=] [--output-item=]
  mc-data get-recipe <id>            Single recipe  [--version=]
  mc-data find-recipes-for <item>    Recipes producing an item  [--version=]
  mc-data loot-tables                Loot table list  [--version=] [--category=]
  mc-data get-loot-table <path>      Single loot table  [--version=]
  mc-data lang                       Language entries  [--version=] [--filter=] [--limit=]
  mc-data blockstate <block>         Blockstate JSON  [--version=]
  mc-data model <path>               Model JSON  [--version=] [--resolve-parents]
  mc-data model-tree <path>          Model parent chain  [--version=]
  mc-data biomes                     Biome list  [--version=]
  mc-data get-biome <id>             Biome data  [--version=]
  mc-data damage-types               Damage type list  [--version=]
  mc-data enchantments               Enchantment list  [--version=]
  mc-data get-enchantment <id>       Enchantment data  [--version=]
  mc-data advancements               Advancement list  [--version=] [--category=]
  mc-data get-advancement <id>       Advancement data  [--version=]
  mc-data structures                 Structure list  [--version=]
  mc-data get-structure <id>         Structure data  [--version=]
  mc-data particles                  Particle list  [--version=]
  mc-data get-particle <id>          Particle data  [--version=]
  mc-data entity-attributes          Entity attribute list  [--entity=] [--version=] [--mod-id=]

MC FILES (misode/mcmeta assets)
  mc-files get-data <path>           Get a data-pack file  [--version=] [--json-only]
  mc-files get-asset <path>          Get an assets file  [--version=] [--json-only]
  mc-files list-files <dir>          List files in a branch dir  --version=  [--branch=]
  mc-files diff <path>               Diff a file across versions  --version-a=  --version-b=  [--branch=data]
  mc-files atlas                     Atlas sprite map  [--version=] [--atlas=blocks]
  mc-files raw <path>                Raw file by git ref  --ref=  
  mc-files compare                   Compare two versions summary  --version-a=  --version-b=  [--branch=]
  mc-files changelog                 Version changelog  --version=  [--branch=]

MOD JAR (file browser)
  mod-jar list-files <modId>         List files inside the JAR  [--prefix=]
  mod-jar get-file <modId>           Read a JAR file  --path=
  mod-jar lang <modId>               Language entries  [--filter=] [--limit=]
  mod-jar sounds <modId>             Sound events  [--namespace=]
  mod-jar atlas <modId>              Atlas sprite map  [--atlas=] [--namespace=]
  mod-jar registry-entries <modId>   Custom registry entries  [--type=] [--filter=] [--limit=]
  mod-jar manifest <modId>           mod.json / mods.toml / fabric.mod.json manifest
  mod-jar list-configs <modId>       List config files in JAR
  mod-jar get-config <modId>         Read a config file  --path=

MOD DATA (structured data from JAR)
  mod-data list <modId> <type>       List data entries  [--namespace=] [--filter=]
  mod-data get <modId> <type> <id>   Get a data entry  [--namespace=] [--registry=] [--model-path=]
  mod-data diff <dbIdA> <dbIdB>      Diff data between two mod versions  [--data-type=]
  mod-data trace-item <itemId>       Trace crafting recipe chain  [--max-depth=]

MOD TAGS (cross-mod data-pack tags)
  mod-tags index <modId>             Index data-pack tags for one mod
  mod-tags index-all                 Index tags for all ingested mods
  mod-tags namespaces                List all tag namespaces
  mod-tags contributors <tagPath>    Mods contributing to a tag  [--registry=]
  mod-tags expand <tagPath>          Recursively expand a tag  [--registry=] [--max-depth=]
  mod-tags mod-list <modId>          Tags provided by a mod  [--registry=]
  mod-tags find-conflicts            Tags with replace:true conflicts  [--registry=]
  mod-tags search <query>            Search tags  [--registry=] [--limit=]

GRADLE
  gradle get-files <modId>           Extract Gradle build files
  gradle search <query>              Search Gradle files across mods  [--mod-id-filter=] [--limit=]
  gradle compare-deps                Compare dependency versions across mods  [--group-filter=] [--mod-id-filter=]

REPORTS (generate Markdown)
  report mixin-conflicts             [--loader=] [--mc-version=] [--min-conflicts=] [--save-path=]
  report tag-conflicts               [--registry=] [--save-path=]
  report version-conflicts           [--save-path=]
  report mod-overview                --mod-id=  [--save-path=]
  report gradle-deps                 [--group-filter=] [--mod-id-filter=] [--save-path=]
  report pack-compat                 --mod-id=  [--save-path=]
  report dep-graph                   [--mc-version=] [--save-path=]
  report sidedness                   [--db-ids=1,2,3] [--save-path=]
  report mod-complexity              [--db-ids=1,2,3] [--save-path=]
  report pack-changelog              --old-ids=1,2  --new-ids=3,4  [--save-path=]

PACK TOOLS
  pack-tools asset-conflicts         Asset path conflicts  [--asset-type=textures|models|sounds|...] [--mc-version=] [--loader=] [--limit=]
  pack-tools vanilla-overrides       Mods overriding vanilla data/assets  [--override-type=data|assets|all] [--data-subtype=] [--mc-version=] [--loader=]
  pack-tools sidedness <modId>       Classify a mod as client/common/server
  pack-tools pack-sidedness          Classify all mods by sidedness  [--mc-version=] [--loader=]
  pack-tools complexity              Mod complexity scores  [--mc-version=] [--loader=]
  pack-tools pack-changelog          Diff two pack snapshots  --old-ids=1,2  --new-ids=3,4
  pack-tools data-conflicts          Data path conflicts  [--data-type=recipe|loot_tables|...] [--mc-version=] [--loader=] [--limit=]

KUBEJS
  kubejs index <scriptsDir>          Index a kubejs/ scripts directory
  kubejs search <scriptsDir> <query> Search indexed KubeJS scripts  [--limit=]

MODPACKS.CH
  modpacks search <query>            Search modpacks  [--namespace=ftb|curseforge] [--limit=20]
  modpacks featured                  Featured packs  [--limit=20]
  modpacks info <packId>             Pack metadata  [--namespace=]
  modpacks manifest <packId> <verId> Pack manifest  [--namespace=]
  modpacks list-versions             Pack version list  [--namespace=] [--pack-id=]
  modpacks list-files                Pack file list  [--namespace=] [--pack-id=] [--version-id=] [--file-type=]
  modpacks ftb-mod-info <modId>      FTB mod info  [--mc-version=] [--loader=]
  modpacks find-mod                  Find a mod across packs  [--mod-db-id=] [--cf-project=]

DIAGNOSTICS
  crash-log <logPath>                Analyze a crash log file (ranked suspect mods)
  missing-deps                       Find declared deps not satisfied in DB  [--mc-version=] [--loader=]
  compat-check <jarPath>             Quick mod compatibility check  [--mc-version=] [--loader=]

FTS / INDEXED SEARCH (no Ollama required)
  index-fts <dbId>                   Index decompiled mod source for BM25/FTS search
                                     Works for all loaders: NeoForge, Fabric, Forge, Quilt
  search-indexed <dbId> <query>      BM25-ranked FTS search over indexed mod source  [--limit=20]

SEMANTIC SEARCH (optional — requires Ollama)
  backfill-embeddings                Embed all docs/primers/mc-source for semantic search
                                     [--type=docs|primers|source] [--version=<mc-version>]
                                     (omit --type to run docs + primers; --type=source needs --version)

Environment:
  DATABASE_URL        PostgreSQL connection string (required)
  OLLAMA_URL          Ollama base URL for semantic search (optional, default http://localhost:11434)
  OLLAMA_EMBED_MODEL  Ollama embedding model (optional, default nomic-embed-text)
  CURSEFORGE_API_KEY  CurseForge API key (optional, needed for sync-curseforge)
`.trim();

// ── Commands ─────────────────────────────────────────────────────────────────

if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
}

const { flags, positional } = parseArgs(rest);

try {
    switch (command) {
        // ── Catalog ───────────────────────────────────────────────────────────
        case "stats": {
            out(await getDbStats());
            break;
        }

        case "list": {
            out(await listMods({
                loader: flags.loader as string | undefined,
                mcVersion: flags.mcVersion as string | undefined,
                hasMixins: flags.hasMixins !== undefined ? !!(flags.hasMixins) : undefined,
                decompiled: flags.decompiled !== undefined ? !!(flags.decompiled) : undefined,
                limit: (flags.limit as number | undefined) ?? 50,
            }));
            break;
        }

        case "get": {
            out(await getModDetails(modIdArg(positional[0], "modId")));
            break;
        }

        case "search": {
            out(await searchMods(requireArg(positional[0], "query"), {
                loader: flags.loader as string | undefined,
                mcVersion: flags.mcVersion as string | undefined,
                limit: (flags.limit as number | undefined) ?? 20,
            }));
            break;
        }

        case "deps": {
            out(await getDependencies(modIdArg(positional[0], "modId"), !!(flags.recursive)));
            break;
        }

        // ── Ingest ────────────────────────────────────────────────────────────
        case "ingest": {
            const jarPath = requireArg(positional[0], "jarPath");
            const result = await ingestMod(jarPath, !!(flags.skipSource));
            out(result);
            if (result.status === "ingested" && !flags.skipIndex) {
                const mod = result.mod as { id: number };
                console.error("Indexing classes...");
                out(await reindexClasses(mod.id));
            }
            break;
        }

        case "ingest-neoforge": {
            const version = requireArg(positional[0], "version");
            console.error(`Downloading NeoForge ${version}...`);
            const jarPath = await downloadNeoForge(version);
            const result = await ingestMod(jarPath, true);
            out(result);
            if (result.status === "ingested" && !flags.skipIndex) {
                const mod = result.mod as { id: number };
                console.error("Indexing classes...");
                out(await reindexClasses(mod.id));
            }
            break;
        }

        case "ingest-fabric-api": {
            const version = requireArg(positional[0], "version");
            console.error(`Downloading Fabric API ${version}...`);
            const jarPath = await downloadFabricApi(version);
            const result = await ingestMod(jarPath, true);
            out(result);
            if (result.status === "ingested" && !flags.skipIndex) {
                const mod = result.mod as { id: number };
                console.error("Indexing classes...");
                out(await reindexClasses(mod.id));
            }
            break;
        }

        case "ingest-forge": {
            const version = requireArg(positional[0], "version");
            console.error(`Downloading Forge ${version}...`);
            const jarPath = await downloadForge(version, flags.mcVersion as string | undefined);
            const result = await ingestMod(jarPath, true);
            out(result);
            if (result.status === "ingested" && !flags.skipIndex) {
                const mod = result.mod as { id: number };
                console.error("Indexing classes...");
                out(await reindexClasses(mod.id));
            }
            break;
        }

        case "batch-ingest": {
            const dir = requireArg(positional[0], "directory");
            const absDir = resolve(dir);
            const entries = await readdir(absDir);
            const jars = entries.filter((f) => f.endsWith(".jar")).sort();
            console.log(`Found ${jars.length} JARs in ${absDir}\n`);
            let ok = 0, skip = 0, fail = 0;
            for (let i = 0; i < jars.length; i++) {
                const jar = jars[i];
                const jarPath = join(absDir, jar);
                const prefix = `[${String(i + 1).padStart(3, " ")}/${jars.length}]`;
                process.stdout.write(`${prefix} ${jar.padEnd(70)} `);
                try {
                    const result = await ingestMod(jarPath, true);
                    if (result.status === "already_ingested" || result.status === "duplicate_version" || result.status === "duplicate_hash") {
                        console.log("SKIP"); skip++;
                    } else {
                        const mod = result.mod as { modId: string; loader: string; version: string };
                        console.log(`OK   ${mod?.modId ?? "?"} (${mod?.loader ?? "?"} ${mod?.version ?? "?"})`);
                        ok++;
                    }
                } catch (e) {
                    console.log(`FAIL ${String(e instanceof Error ? e.message : e).slice(0, 80)}`);
                    fail++;
                }
            }
            console.log(`\n✓ ingested: ${ok}  skipped: ${skip}  failed: ${fail}`);
            if (flags.index) {
                console.log("\nIndexing classes...");
                const idx = await reindexClasses();
                console.log(`✓ indexed: ${idx.indexed}  already had classes: ${idx.skipped}  failed: ${idx.failed}`);
            }
            break;
        }

        case "reindex": {
            out(await reindexClasses(flags.dbId as number | undefined));
            break;
        }

        // ── Source / decompile ────────────────────────────────────────────────
        case "decompile": {
            console.error("Decompiling (this may take a while)...");
            out(await decompileMod(numArg(positional[0], "dbId")));
            break;
        }

        case "decompile-class": {
            out(await decompileModClass(
                numArg(positional[0], "dbId"),
                requireArg(positional[1], "className"),
            ));
            break;
        }

        case "source": {
            out(await getModSource(numArg(positional[0], "dbId"), positional[1]));
            break;
        }

        case "search-source": {
            out(await searchSource(
                requireArg(positional[0], "query"),
                flags.dbId as number | undefined,
                !!(flags.regex),
                (flags.limit as number | undefined) ?? 50,
            ));
            break;
        }

        // ── Bytecode ──────────────────────────────────────────────────────────
        case "search-class": {
            const results = await searchModClass(
                numArg(positional[0], "dbId"),
                requireArg(positional[1], "query"),
            );
            out(results.length === 0 ? "No classes found." : results.join("\n"));
            break;
        }

        case "members": {
            out(await getModClassMembers(
                numArg(positional[0], "dbId"),
                requireArg(positional[1], "className"),
            ));
            break;
        }

        case "bytecode": {
            out(await getModClassBytecode(
                numArg(positional[0], "dbId"),
                requireArg(positional[1], "className"),
            ));
            break;
        }

        case "refs": {
            out(await findModReferences(
                numArg(positional[0], "dbId"),
                requireArg(positional[1], "target"),
            ));
            break;
        }

        case "inheritance": {
            out(await getModInheritance(
                numArg(positional[0], "dbId"),
                requireArg(positional[1], "className"),
            ));
            break;
        }

        case "diff": {
            out(await diffModVersions(
                numArg(positional[0], "dbIdA"),
                numArg(positional[1], "dbIdB"),
            ));
            break;
        }

        // ── Mixins ────────────────────────────────────────────────────────────
        case "mixin-targets": {
            out(await getMixinTargets(modIdArg(positional[0], "modId")));
            break;
        }

        case "resolve-mixins": {
            out(await resolveMixinTargets(numArg(positional[0], "dbId")));
            break;
        }

        case "mixin-conflicts": {
            out(await getMixinConflicts(requireArg(positional[0], "targetClass")));
            break;
        }

        case "at-entries": {
            out(await getAtEntries(numArg(positional[0], "dbId")));
            break;
        }

        case "aw-entries": {
            out(await getAwEntries(numArg(positional[0], "dbId")));
            break;
        }

        // ── Platform ──────────────────────────────────────────────────────────
        case "sync-modrinth": {
            out(await syncModrinth(numArg(positional[0], "dbId")));
            break;
        }

        case "sync-curseforge": {
            out(await syncCurseforge(numArg(positional[0], "dbId")));
            break;
        }

        case "check-updates": {
            out(await checkUpdates(numArg(positional[0], "dbId")));
            break;
        }

        case "download-source": {
            out(await downloadSource(numArg(positional[0], "dbId")));
            break;
        }

        // ── Versions ──────────────────────────────────────────────────────────
        case "mc-versions": {
            out(await listMcVersions((flags.type as "release" | "snapshot" | "all") ?? "release"));
            break;
        }

        case "neoforge-versions": {
            out(await listNeoForgeVersions(
                flags.mcVersion as string | undefined,
                (flags.limit as number | undefined) ?? 20,
            ));
            break;
        }

        case "fabric-api-versions": {
            out(await listFabricApiVersions(
                flags.mcVersion as string | undefined,
                (flags.limit as number | undefined) ?? 20,
            ));
            break;
        }

        // ── Batch resolve mixins ───────────────────────────────────────────────
        case "batch-resolve-mixins": {
            const mods = await (await getDb()).mod.findMany({
                where: { hasMixins: true },
                select: { id: true, modId: true },
                orderBy: { id: "asc" },
            });
            console.log(`Resolving mixin targets for ${mods.length} mods...\n`);
            let ok = 0, none = 0, fail = 0;
            for (const mod of mods) {
                process.stdout.write(`[${String(mod.id).padStart(3, " ")}] ${mod.modId.padEnd(50)} `);
                try {
                    const result = await resolveMixinTargets(mod.id);
                    if (result.targets.length === 0) {
                        console.log(`NONE  (${result.skipped} skipped, ${result.failed} failed)`);
                        none++;
                    } else {
                        console.log(`OK    ${result.targets.length} targets (${result.resolved} resolved, ${result.failed} failed)`);
                        ok++;
                    }
                } catch (e) {
                    console.log(`FAIL  ${String(e instanceof Error ? e.message : e).slice(0, 60)}`);
                    fail++;
                }
            }
            console.log(`\n✓ resolved: ${ok}  no targets found: ${none}  failed: ${fail}`);
            break;
        }

        case "index-fts": {
            const dbId = numArg(positional[0], "dbId");
            console.error(`Indexing mod source (FTS) for dbId=${dbId}...`);
            out(await indexModSourceFts(dbId));
            break;
        }

        case "search-indexed": {
            const dbId = numArg(positional[0], "dbId");
            const query = requireArg(positional[1], "query");
            const limit = (flags.limit as number | undefined) ?? 20;
            out(await searchModSourceIndexed(dbId, query, limit));
            break;
        }

        // ── Mod: additional actions ───────────────────────────────────────────
        case "dep-graph": {
            out(await getDependencyGraph(flags.mcVersion as string | undefined));
            break;
        }

        case "version-conflicts": {
            out(await findVersionConflicts());
            break;
        }

        case "source-urls": {
            out(await listModSourceUrls(positional[0]));
            break;
        }

        case "decompile-status": {
            out(await decompileModStatus(numArg(positional[0], "dbId")));
            break;
        }

        case "batch-decompile": {
            const concurrency = (flags.concurrency as number | undefined) ?? 2;
            const autoEmbed = flags["auto-embed"] === true ? true : flags["auto-embed"] === false ? false : undefined;
            const autoGraph = flags["auto-graph"] === true ? true : flags["auto-graph"] === false ? false : undefined;
            console.error(`Batch decompiling all un-decompiled mods (concurrency=${concurrency})...`);
            out(await batchDecompileMods({ concurrency, autoEmbed, autoGraph }));
            break;
        }

        case "get-paths": {
            const mod = await findModById(numArg(positional[0], "dbId"));
            if (!mod) die(`Mod #${positional[0]} not found`);
            out({ dbId: mod.id, modId: mod.modId, version: mod.version, jarPath: mod.jarPath, decompPath: mod.decompPath ?? null, cacheRoot: CACHE_ROOT });
            break;
        }

        case "batch-sync": {
            out(await batchSyncSources({
                syncModrinth: flags.syncModrinth !== undefined ? !!(flags.syncModrinth) : undefined,
                syncCurseforge: flags.syncCurseforge !== undefined ? !!(flags.syncCurseforge) : undefined,
                downloadSources: !!(flags.downloadSources),
                modIdFilter: flags.modIdFilter as string | undefined,
                limit: flags.limit as number | undefined,
            }));
            break;
        }

        // ── Mod bytecode: advanced ────────────────────────────────────────────
        case "cross-refs": {
            out(await crossModRefs(
                requireArg(positional[0], "target"),
                flags.mcVersion as string | undefined,
                flags.loader as string | undefined,
                flags.limit as number | undefined,
            ));
            break;
        }

        case "diff-detailed": {
            const packages = flags.packages ? String(flags.packages).split(",") : undefined;
            out(await diffModVersionsDetailed(
                numArg(positional[0], "dbIdA"),
                numArg(positional[1], "dbIdB"),
                packages,
                (flags.limit as number | undefined) ?? 200,
                !!(flags.semantic),
                flags.cache !== undefined ? !!(flags.cache) : !!(process.env.AUTO_CACHE_MOD_DIFFS),
                !!(flags.force),
            ));
            break;
        }

        case "find-implementors": {
            out(await findImplementors(
                requireArg(positional[0], "target"),
                flags.modId as string | number | undefined,
                flags.limit as number | undefined,
                !!(flags.transitive),
            ));
            break;
        }

        case "scan-registrations": {
            out(await scanModRegistrations(numArg(positional[0], "dbId")));
            break;
        }

        case "annotated-by": {
            out(await findAnnotatedClasses(
                requireArg(positional[0], "annotation"),
                flags.modId as string | number | undefined,
                flags.limit as number | undefined,
            ));
            break;
        }

        case "event-listeners": {
            out(await findEventListeners(
                requireArg(positional[0], "event"),
                flags.modId as string | number | undefined,
                flags.limit as number | undefined,
            ));
            break;
        }

        case "optional-integrations": {
            out(await findOptionalIntegrations(numArg(positional[0], "dbId")));
            break;
        }

        case "network-payloads": {
            out(await findNetworkPayloads(numArg(positional[0], "dbId")));
            break;
        }

        case "config-schema": {
            out(await extractConfigSchema(numArg(positional[0], "dbId")));
            break;
        }

        // ── Mixin analysis: advanced ──────────────────────────────────────────
        case "targets-in-package": {
            out(await getMixinsTargetingPackage(
                requireArg(positional[0], "packagePrefix"),
                flags.mcVersion as string | undefined,
            ));
            break;
        }

        case "at-conflicts": {
            out(await findAtAwConflicts(
                flags.mcVersion as string | undefined,
                flags.loader as string | undefined,
            ));
            break;
        }

        // ── Mixin scan ────────────────────────────────────────────────────────
        case "mixin-scan": {
            const sub = requireArg(positional[0], "mixin-scan action");
            switch (sub) {
                case "list":
                    out(await listModsWithMixins(flags.loader as string | undefined, flags.mcVersion as string | undefined));
                    break;
                case "conflict-matrix":
                    out(await getMixinConflictMatrix(flags.loader as string | undefined, flags.mcVersion as string | undefined, flags.minConflicts as number | undefined));
                    break;
                case "class-detail":
                    out(await getMixinClassDetail(requireArg(positional[1], "targetClass")));
                    break;
                case "hotspots":
                    out(await getMixinHotspots(flags.top as number | undefined, flags.loader as string | undefined));
                    break;
                case "batch-resolve":
                    out(await batchResolveMixins(flags.loader as string | undefined, flags.mcVersion as string | undefined));
                    break;
                default:
                    die(`Unknown mixin-scan action: ${sub}. Use: list|conflict-matrix|class-detail|hotspots|batch-resolve`);
            }
            break;
        }

        // ── Vanilla MC source ─────────────────────────────────────────────────
        case "mc-source": {
            const sub = requireArg(positional[0], "mc-source action");
            switch (sub) {
                case "search-class":
                    out(await searchMinecraftClass(requireArg(positional[1], "version"), requireArg(positional[2], "query")));
                    break;
                case "get-source":
                    out(await getMinecraftSource(
                        requireArg(positional[1], "version"),
                        requireArg(positional[2], "className"),
                        flags.startLine as number | undefined,
                        flags.endLine as number | undefined,
                        flags.maxLines as number | undefined,
                    ));
                    break;
                case "bytecode":
                    out(await getMcClassBytecode(requireArg(positional[1], "version"), requireArg(positional[2], "className")));
                    break;
                case "class-members":
                    out(await getMcClassMembers(requireArg(positional[1], "version"), requireArg(positional[2], "className")));
                    break;
                case "find-refs":
                    out(await findMcReferences(requireArg(positional[1], "version"), requireArg(positional[2], "target")));
                    break;
                case "inheritance":
                    out(await getMcInheritance(requireArg(positional[1], "version"), requireArg(positional[2], "className")));
                    break;
                case "diff":
                    out(await diffMcVersions(requireArg(positional[1], "versionA"), requireArg(positional[2], "versionB")));
                    break;
                case "diff-detailed": {
                    const pkgs = flags.packages ? String(flags.packages).split(",") : undefined;
                    out(await diffMcVersionsDetailed(
                        requireArg(positional[1], "versionA"),
                        requireArg(positional[2], "versionB"),
                        pkgs,
                        (flags.limit as number | undefined) ?? 200,
                        !!(flags.force),
                        !!(flags.semantic),
                        flags.cache !== undefined ? !!(flags.cache) : true,
                    ));
                    break;
                }
                case "decompile":
                    console.error("Decompiling MC (this may take a while)...");
                    out(await decompileMcVersion(requireArg(positional[1], "version"), !!(flags.force)));
                    break;
                case "decompile-status":
                    out(await decompileMcVersionStatus(requireArg(positional[1], "version")));
                    break;
                case "search-code":
                    out(await searchMcCode(
                        requireArg(positional[1], "version"),
                        requireArg(positional[2], "query"),
                        (flags.searchType as any) ?? "content",
                        !!(flags.regex),
                        (flags.limit as number | undefined) ?? 50,
                    ));
                    break;
                case "index":
                    out(await indexMcVersion(requireArg(positional[1], "version"), !!(flags.force)));
                    break;
                case "search-indexed":
                    out(await searchMcIndexed(
                        requireArg(positional[2], "query"),
                        requireArg(positional[1], "version"),
                        (flags.limit as number | undefined) ?? 20,
                    ));
                    break;
                case "search-events":
                    out(await searchEvents(requireArg(positional[1], "version"), positional[2], flags.modloader as any));
                    break;
                case "validate-aw": {
                    const awPath = requireArg(positional[2], "awFilePath");
                    const content = await readFile(awPath, "utf8");
                    out(await validateAccessWidener(content, requireArg(positional[1], "version")));
                    break;
                }
                case "analyze-mixin": {
                    const mixinPath = requireArg(positional[2], "mixinFilePath");
                    const source = await readFile(mixinPath, "utf8");
                    out(await analyzeMixin(source, requireArg(positional[1], "version")));
                    break;
                }
                case "search-semantic":
                    out(await searchMcSourceSemantic(
                        requireArg(positional[2], "query"),
                        requireArg(positional[1], "version"),
                        (flags.limit as number | undefined) ?? 10,
                    ));
                    break;
                case "get-paths": {
                    const ver = requireArg(positional[1], "version");
                    out({ version: ver, jarPath: mcPaths.jar(ver), decompPath: mcPaths.decompiled(ver), indexPath: mcPaths.index(ver), cacheRoot: CACHE_ROOT });
                    break;
                }
                default:
                    die(`Unknown mc-source action: ${sub}. Run without args to see all commands.`);
            }
            break;
        }

        // ── Mappings ──────────────────────────────────────────────────────────
        case "mappings": {
            const sub = requireArg(positional[0], "mappings action");
            switch (sub) {
                case "find":
                    out(await findMapping(
                        requireArg(positional[1], "symbol"),
                        requireArg(positional[2], "version"),
                        requireArg(positional[3], "sourceNs") as any,
                        requireArg(positional[4], "targetNs") as any,
                    ));
                    break;
                case "remap":
                    out(await remapModJar(
                        requireArg(positional[1], "inputJar"),
                        requireArg(positional[2], "outputJar"),
                        requireArg(positional[3], "version"),
                        requireArg(positional[4], "toMapping") as any,
                    ));
                    break;
                case "parchment":
                    out(await getParchment(requireArg(positional[1], "className"), requireArg(positional[2], "mcVersion")));
                    break;
                case "list-parchment":
                    out(await listParchmentVersions(requireArg(positional[1], "mcVersion")));
                    break;
                case "parchment-summary":
                    out(await getParchmentSummary(requireArg(positional[1], "mcVersion")));
                    break;
                default:
                    die(`Unknown mappings action: ${sub}. Use: find|remap|parchment|list-parchment|parchment-summary`);
            }
            break;
        }

        // ── Docs ──────────────────────────────────────────────────────────────
        case "docs": {
            const sub = requireArg(positional[0], "docs action");
            switch (sub) {
                case "seed":
                    out(await seedDefaultDocumentation());
                    break;
                case "get":
                    out(await getDocumentation(requireArg(positional[1], "query")));
                    break;
                case "search":
                    out(await searchDocumentation(
                        requireArg(positional[1], "query"),
                        flags.category as string | undefined,
                        flags.namespace as string | undefined,
                    ));
                    break;
                case "list":
                    out(await listDocumentation(
                        flags.category as string | undefined,
                        flags.namespace as string | undefined,
                        flags.tag as string | undefined,
                        (flags.limit as number | undefined) ?? 100,
                    ));
                    break;
                case "delete":
                    out(await deleteDocumentation(numArg(positional[1], "id")));
                    break;
                case "semantic-search":
                    out(await semanticSearchDocumentation(requireArg(positional[1], "query"), (flags.limit as number | undefined) ?? 10));
                    break;
                default:
                    die(`Unknown docs action: ${sub}. Use: seed|get|search|list|delete|semantic-search`);
            }
            break;
        }

        // ── Primers ───────────────────────────────────────────────────────────
        case "primers": {
            const sub = requireArg(positional[0], "primers action");
            switch (sub) {
                case "seed":
                    out(await seedDefaultPrimers());
                    break;
                case "get":
                    out(await getPrimer(numArg(positional[1], "id")));
                    break;
                case "by-version":
                    out(await getPrimersByVersionRange(
                        requireArg(positional[1], "fromVersion"),
                        requireArg(positional[2], "toVersion"),
                        flags.modloader as string | undefined,
                    ));
                    break;
                case "search":
                    out(await searchPrimers(
                        requireArg(positional[1], "query"),
                        flags.modloader as string | undefined,
                        undefined,
                        undefined,
                        flags.limit as number | undefined,
                    ));
                    break;
                case "list":
                    out(await listPrimers(flags.modloader as string | undefined, flags.limit as number | undefined));
                    break;
                case "delete":
                    out(await deletePrimer(numArg(positional[1], "id")));
                    break;
                case "semantic-search":
                    out(await semanticSearchPrimers(requireArg(positional[1], "query"), (flags.limit as number | undefined) ?? 10));
                    break;
                default:
                    die(`Unknown primers action: ${sub}. Use: seed|get|by-version|search|list|delete|semantic-search`);
            }
            break;
        }

        // ── MC Registry ───────────────────────────────────────────────────────
        case "mc-registry": {
            const sub = requireArg(positional[0], "mc-registry action");
            const ver = flags.version as string | undefined;
            switch (sub) {
                case "blocks":           out(await getMcBlocks(ver)); break;
                case "commands":         out(await getMcCommands(ver)); break;
                case "registries":       out(await getMcRegistries(ver, flags.registry as string | undefined)); break;
                case "sounds":           out(await getMcSounds(ver)); break;
                case "item-components":  out(await getMcItemComponents(ver)); break;
                case "registry-entries": out(await getRegistryEntries(requireArg(positional[1] ?? String(flags.registry ?? ""), "registry"), ver)); break;
                case "mcmeta-versions":  out(await getMcmetaVersions((flags.filter as any) ?? "all")); break;
                default:
                    die(`Unknown mc-registry action: ${sub}. Use: blocks|commands|registries|sounds|item-components|registry-entries|mcmeta-versions`);
            }
            break;
        }

        // ── MC Data ───────────────────────────────────────────────────────────
        case "mc-data": {
            const sub = requireArg(positional[0], "mc-data action");
            const ver = flags.version as string | undefined;
            switch (sub) {
                case "tags":              out(await getMcTags(ver, flags.registry as string | undefined, flags.tagId as string | undefined, flags.namespace as string | undefined)); break;
                case "find-tags-for":     out(await findTagsForEntry(requireArg(positional[1], "entry"), requireArg(String(flags.registry ?? ""), "registry"), ver, flags.namespace as string | undefined)); break;
                case "recipes":           out(await listRecipes(ver, flags.type as string | undefined, flags.outputItem as string | undefined)); break;
                case "get-recipe":        out(await getRecipe(ver, requireArg(positional[1], "recipeId"))); break;
                case "find-recipes-for":  out(await findRecipesForItem(requireArg(positional[1], "item"), ver)); break;
                case "loot-tables":       out(await listLootTables(ver, flags.category as string | undefined)); break;
                case "get-loot-table":    out(await getLootTable(ver, requireArg(positional[1], "path"))); break;
                case "lang":              out(await getLangEntries(ver, flags.filter as string | undefined, flags.limit as number | undefined)); break;
                case "blockstate":        out(await getBlockstate(ver, requireArg(positional[1], "block"))); break;
                case "model":             out(await getMcModel(ver, requireArg(positional[1], "modelPath"), !!(flags.resolveParents))); break;
                case "model-tree":        out(await getModelTree(requireArg(positional[1], "modelPath"), ver)); break;
                case "biomes":            out(await listBiomes(ver)); break;
                case "get-biome":         out(await getBiome(ver, requireArg(positional[1], "biomeId"))); break;
                case "damage-types":      out(await listDamageTypes(ver)); break;
                case "enchantments":      out(await listEnchantments(ver)); break;
                case "get-enchantment":   out(await getEnchantment(ver, requireArg(positional[1], "id"))); break;
                case "advancements":      out(await listAdvancements(ver, flags.category as string | undefined)); break;
                case "get-advancement":   out(await getAdvancement(ver, requireArg(positional[1], "id"))); break;
                case "structures":        out(await listStructures(ver)); break;
                case "get-structure":     out(await getStructureData(requireArg(positional[1], "id"), ver)); break;
                case "particles":         out(await getMcParticles(ver)); break;
                case "get-particle":      out(await getParticleData(requireArg(positional[1], "id"), ver)); break;
                case "entity-attributes": out(await getEntityAttributes(flags.entity as string | undefined, ver, flags.modId as string | number | undefined)); break;
                default:
                    die(`Unknown mc-data action: ${sub}. Run without args to see all commands.`);
            }
            break;
        }

        // ── MC Files ──────────────────────────────────────────────────────────
        case "mc-files": {
            const sub = requireArg(positional[0], "mc-files action");
            const ver = flags.version as string | undefined;
            switch (sub) {
                case "get-data":   out(await getMcDataFile(requireArg(positional[1], "filePath"), ver, !!(flags.jsonOnly))); break;
                case "get-asset":  out(await getMcAssetFile(requireArg(positional[1], "filePath"), ver, !!(flags.jsonOnly))); break;
                case "list-files": out(await listMcDataFiles(requireArg(positional[1], "dirPath"), requireArg(ver ?? "", "version"), flags.branch as any)); break;
                case "diff":       out(await diffMcData(requireArg(positional[1], "filePath"), requireArg(String(flags.versionA ?? ""), "versionA"), requireArg(String(flags.versionB ?? ""), "versionB"), (flags.branch as any) ?? "data")); break;
                case "atlas":      out(await getMcAtlas(ver, flags.atlas as string | undefined)); break;
                case "raw":        out(await getMcmetaRaw(requireArg(String(flags.ref ?? ""), "ref"), requireArg(positional[1], "filePath"))); break;
                case "compare":    out(await compareVersions(requireArg(String(flags.versionA ?? ""), "versionA"), requireArg(String(flags.versionB ?? ""), "versionB"), flags.branch as string | undefined)); break;
                case "changelog":  out(await getVersionChangelog(requireArg(ver ?? "", "version"), flags.branch as string | undefined)); break;
                default:
                    die(`Unknown mc-files action: ${sub}. Use: get-data|get-asset|list-files|diff|atlas|raw|compare|changelog`);
            }
            break;
        }

        // ── Mod JAR ───────────────────────────────────────────────────────────
        case "mod-jar": {
            const sub = requireArg(positional[0], "mod-jar action");
            const mid = modIdArg(positional[1], "modId");
            switch (sub) {
                case "list-files":       out(await listModJarFiles(mid, flags.prefix as string | undefined)); break;
                case "get-file":         out(await getModJarFile(mid, requireArg(String(flags.path ?? positional[2] ?? ""), "path"))); break;
                case "lang":             out(await getModLang(mid, flags.filter as string | undefined, flags.limit as number | undefined)); break;
                case "sounds":           out(await getModSounds(mid, flags.namespace as string | undefined)); break;
                case "atlas":            out(await getModAtlas(mid, flags.atlas as string | undefined, flags.namespace as string | undefined)); break;
                case "registry-entries": out(await listModRegistryEntries(mid, flags.type as any, flags.filter as string | undefined, flags.limit as number | undefined)); break;
                case "manifest":         out(await getModManifest(mid)); break;
                case "list-configs":     out(await listModConfigs(mid)); break;
                case "get-config":       out(await getModConfig(mid, requireArg(String(flags.path ?? positional[2] ?? ""), "path"))); break;
                default:
                    die(`Unknown mod-jar action: ${sub}. Use: list-files|get-file|lang|sounds|atlas|registry-entries|manifest|list-configs|get-config`);
            }
            break;
        }

        // ── Mod Data ──────────────────────────────────────────────────────────
        case "mod-data": {
            const sub = requireArg(positional[0], "mod-data action");
            switch (sub) {
                case "list": {
                    const mid = modIdArg(positional[1], "modId");
                    const type = requireArg(positional[2] ?? String(flags.type ?? ""), "type") as any;
                    if (type === "data_tag") {
                        out(await listModDataTags(mid, flags.registry as string | undefined, flags.namespace as string | undefined, flags.filter as string | undefined));
                    } else {
                        out(await listModData(mid, type, { namespace: flags.namespace as string | undefined, filter: flags.filter as string | undefined }));
                    }
                    break;
                }
                case "get": {
                    const mid = modIdArg(positional[1], "modId");
                    const type = requireArg(positional[2] ?? String(flags.type ?? ""), "type") as any;
                    const id = requireArg(positional[3] ?? String(flags.id ?? ""), "id");
                    if (type === "model") {
                        out(await getModModelData(mid, flags.modelPath as string | undefined ?? id, flags.namespace as string | undefined));
                    } else if (type === "data_tag") {
                        out(await getModDataTag(mid, requireArg(String(flags.registry ?? ""), "registry"), id, flags.namespace as string | undefined));
                    } else {
                        out(await getModData(mid, type, id, { namespace: flags.namespace as string | undefined }));
                    }
                    break;
                }
                case "diff":
                    out(await diffModData(numArg(positional[1], "dbIdA"), numArg(positional[2], "dbIdB"), flags.dataType as string | undefined));
                    break;
                case "trace-item":
                    out(await traceRecipeChain(requireArg(positional[1], "itemId"), flags.maxDepth as number | undefined));
                    break;
                default:
                    die(`Unknown mod-data action: ${sub}. Use: list|get|diff|trace-item`);
            }
            break;
        }

        // ── Mod Tags ──────────────────────────────────────────────────────────
        case "mod-tags": {
            const sub = requireArg(positional[0], "mod-tags action");
            switch (sub) {
                case "index":          out(await indexModTags(modIdArg(positional[1], "modId"))); break;
                case "index-all":      out(await indexAllModTags()); break;
                case "namespaces":     out(await listTagNamespaces()); break;
                case "contributors":   out(await getTagContributors(requireArg(positional[1], "tagPath"), flags.registry as string | undefined)); break;
                case "expand":         out(await expandTag(requireArg(positional[1], "tagPath"), flags.registry as string | undefined, flags.maxDepth as number | undefined)); break;
                case "mod-list":       out(await getModTagList(modIdArg(positional[1], "modId"), flags.registry as string | undefined)); break;
                case "find-conflicts": out(await findTagConflicts(flags.registry as string | undefined)); break;
                case "search":         out(await searchModTags(requireArg(positional[1], "query"), flags.registry as string | undefined, flags.limit as number | undefined)); break;
                default:
                    die(`Unknown mod-tags action: ${sub}. Use: index|index-all|namespaces|contributors|expand|mod-list|find-conflicts|search`);
            }
            break;
        }

        // ── Gradle ────────────────────────────────────────────────────────────
        case "gradle": {
            const sub = requireArg(positional[0], "gradle action");
            switch (sub) {
                case "get-files":    out(await getModGradleFiles(modIdArg(positional[1], "modId"))); break;
                case "search":       out(await searchGradleFiles(requireArg(positional[1], "query"), flags.modIdFilter as string | undefined, flags.limit as number | undefined)); break;
                case "compare-deps": out(await compareGradleDeps(flags.groupFilter as string | undefined, flags.modIdFilter as string | undefined)); break;
                default:
                    die(`Unknown gradle action: ${sub}. Use: get-files|search|compare-deps`);
            }
            break;
        }

        // ── Reports ───────────────────────────────────────────────────────────
        case "report": {
            const reportType = requireArg(positional[0], "report type");
            const dbIds = flags.dbIds ? String(flags.dbIds).split(",").map(Number) : undefined;
            const oldIds = flags.oldIds ? String(flags.oldIds).split(",").map(Number) : undefined;
            const newIds = flags.newIds ? String(flags.newIds).split(",").map(Number) : undefined;
            const result = await generateReport({
                report: reportType as any,
                savePath: flags.savePath as string | undefined,
                modId: flags.modId as string | number | undefined,
                loader: flags.loader as string | undefined,
                mcVersion: flags.mcVersion as string | undefined,
                registry: flags.registry as string | undefined,
                minConflicts: flags.minConflicts as number | undefined,
                groupFilter: flags.groupFilter as string | undefined,
                modIdFilter: flags.modIdFilter as string | undefined,
                dbIds, oldIds, newIds,
            });
            out(result.savedTo ? `Saved to: ${result.savedTo}\n\n${result.markdown}` : result.markdown);
            break;
        }

        // ── Pack Tools ────────────────────────────────────────────────────────
        case "pack-tools": {
            const sub = requireArg(positional[0], "pack-tools action");
            switch (sub) {
                case "asset-conflicts":
                    out(await findAssetConflicts(flags.assetType as any, flags.mcVersion as string | undefined, flags.loader as string | undefined, flags.limit as number | undefined));
                    break;
                case "vanilla-overrides":
                    out(await findVanillaOverrides(flags.overrideType as any, flags.dataSubtype as string | undefined, flags.mcVersion as string | undefined, flags.loader as string | undefined));
                    break;
                case "sidedness":
                    out(await analyzeModSidedness(modIdArg(positional[1], "modId")));
                    break;
                case "pack-sidedness":
                    out(await analyzePackSidedness(flags.mcVersion as string | undefined, flags.loader as string | undefined));
                    break;
                case "complexity":
                    out(await computeModComplexity(flags.mcVersion as string | undefined, flags.loader as string | undefined));
                    break;
                case "pack-changelog": {
                    const oldI = flags.oldIds ? String(flags.oldIds).split(",").map(Number) : [];
                    const newI = flags.newIds ? String(flags.newIds).split(",").map(Number) : [];
                    out(await computePackChangelog(oldI, newI));
                    break;
                }
                case "data-conflicts":
                    out(await findDataConflicts(flags.dataType as any, flags.mcVersion as string | undefined, flags.loader as string | undefined, flags.limit as number | undefined));
                    break;
                default:
                    die(`Unknown pack-tools action: ${sub}. Use: asset-conflicts|vanilla-overrides|sidedness|pack-sidedness|complexity|pack-changelog|data-conflicts`);
            }
            break;
        }

        // ── KubeJS ────────────────────────────────────────────────────────────
        case "kubejs": {
            const sub = requireArg(positional[0], "kubejs action");
            const dir = requireArg(positional[1], "scriptsDir");
            switch (sub) {
                case "index":  out(await indexKubeJsScripts(dir)); break;
                case "search": out(await searchKubeJsScripts(dir, requireArg(positional[2], "query"), flags.limit as number | undefined)); break;
                default:       die(`Unknown kubejs action: ${sub}. Use: index|search`);
            }
            break;
        }

        // ── Modpacks.ch ───────────────────────────────────────────────────────
        case "modpacks": {
            const sub = requireArg(positional[0], "modpacks action");
            const ns = (flags.namespace as "ftb" | "curseforge" | undefined) ?? "ftb";
            switch (sub) {
                case "search":
                    out(await searchPacksAction(requireArg(positional[1], "query"), ns, (flags.limit as number | undefined) ?? 20));
                    break;
                case "featured":
                    out(await featuredPacksAction((flags.limit as number | undefined) ?? 20));
                    break;
                case "info":
                    out(await packInfoAction(numArg(positional[1], "packId"), ns));
                    break;
                case "manifest":
                    out(await packManifestAction(numArg(positional[1], "packId"), numArg(positional[2], "versionId"), ns));
                    break;
                case "list-versions":
                    out(await listPackVersionsAction(flags.namespace as any, flags.packId as number | undefined));
                    break;
                case "list-files":
                    out(await listPackFilesAction({ namespace: flags.namespace as any, packId: flags.packId as number | undefined, versionId: flags.versionId as number | undefined, fileType: flags.fileType as string | undefined }));
                    break;
                case "ftb-mod-info":
                    out(await ftbModInfoAction(modIdArg(positional[1], "modId"), { mcVersion: flags.mcVersion as string | undefined, loader: flags.loader as string | undefined }));
                    break;
                case "find-mod":
                    out(await findModInPacksAction({ modDbId: flags.modDbId as number | undefined, cfProject: flags.cfProject as number | undefined }));
                    break;
                default:
                    die(`Unknown modpacks action: ${sub}. Use: search|featured|info|manifest|list-versions|list-files|ftb-mod-info|find-mod`);
            }
            break;
        }

        // ── Crash log ─────────────────────────────────────────────────────────
        case "crash-log": {
            const logPath = requireArg(positional[0], "logPath");
            const logText = await readFile(logPath, "utf8");
            out(await analyzeCrashLog(logText));
            break;
        }

        // ── Missing deps ──────────────────────────────────────────────────────
        case "missing-deps": {
            out(await findMissingDeps(
                flags.mcVersion as string | undefined,
                flags.loader as string | undefined,
            ));
            break;
        }

        // ── Compat check ──────────────────────────────────────────────────────
        case "compat-check": {
            out(await checkModCompat(
                requireArg(positional[0], "jarPath"),
                flags.mcVersion as string | undefined,
                flags.loader as string | undefined,
            ));
            break;
        }

        case "backfill-embeddings": {
            const type = flags.type as string | undefined;
            const version = flags.version as string | undefined;
            if (!type || type === "docs") {
                console.log("Embedding docs...");
                out(await backfillDocEmbeddings());
            }
            if (!type || type === "primers") {
                console.log("Embedding primers...");
                out(await backfillPrimerEmbeddings());
            }
            if (type === "source") {
                if (!version) die("--version=<mc-version> is required for --type=source");
                console.log(`Embedding MC source for ${version}...`);
                out(await indexMcSourceSemantic(version));
            }
            if (type === "mod") {
                const dbId = flags.dbId as number | undefined;
                if (!dbId) die("--db-id=<n> is required for --type=mod");
                const batchSize = (flags.batchSize as number | undefined) ?? 50;
                console.log(`Embedding mod source for dbId=${dbId} (batch=${batchSize})...`);
                out(await indexModSourceSemantic(dbId, batchSize));
            }
            break;
        }

        default:
            die(`Unknown command: ${command}\nRun without arguments to see all commands.`);
    }
} finally {
    await disconnect();
}
