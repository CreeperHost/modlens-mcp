/**
 * modlens CLI — command-line interface for all modlens-mcp operations.
 * Usage: node dist/cli.js <command> [args] [--flags]
 *        Run without arguments to see all commands.
 */
import { ingestMod, decompileMod, reindexClasses } from "./tools/ingest.js";
import { listMods, getModDetails, searchMods, getDbStats, getDependencies } from "./tools/catalog.js";
import { getModSource, searchSource, decompileModClass } from "./tools/source.js";
import {
    searchModClass, getModClassMembers, getModClassBytecode,
    findModReferences, getModInheritance, diffModVersions,
} from "./tools/bytecode.js";
import { getMixinTargets, getMixinConflicts, getAtEntries, getAwEntries, resolveMixinTargets } from "./tools/mixin-scan.js";
import { syncModrinth, syncCurseforge, checkUpdates, downloadSource } from "./tools/platform.js";
import {
    listMcVersions, listNeoForgeVersions, listFabricApiVersions,
    downloadNeoForge, downloadFabricApi,
} from "./platform.js";
import { getDb, disconnect } from "./db.js";
import { readdir } from "fs/promises";
import { join, resolve } from "path";
import { backfillDocEmbeddings } from "./tools/docs.js";
import { backfillPrimerEmbeddings } from "./tools/primers.js";
import { indexMcSourceSemantic } from "./tools/mc-fts.js";

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
            break;
        }

        default:
            die(`Unknown command: ${command}\nRun without arguments to see all commands.`);
    }
} finally {
    await disconnect();
}
