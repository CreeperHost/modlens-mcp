import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ingestMod, decompileMod, reindexClasses } from "./tools/ingest.js";
import { listMods, getModDetails, searchMods, getDbStats, getDependencies } from "./tools/catalog.js";
import { getModSource, searchSource, decompileModClass } from "./tools/source.js";
import {
    searchModClass, getModClassMembers, getModClassBytecode,
    findModReferences, getModInheritance, diffModVersions,
} from "./tools/bytecode.js";
import { getMixinTargets, getMixinConflicts, getAtEntries, getAwEntries } from "./tools/mixins.js";
import { syncModrinth, syncCurseforge, checkUpdates, downloadSource } from "./tools/platform.js";
import { listMcVersions, listNeoForgeVersions, listFabricApiVersions } from "./platform.js";
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
    "Decompile an entire mod JAR using Vineflower. Downloads Vineflower automatically on first use. Results cached.",
    { dbId: z.number().describe("Database ID of the mod") },
    async ({ dbId }) => {
        const outDir = await decompileMod(dbId);
        return { content: [{ type: "text", text: `Decompiled to: ${outDir}` }] };
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

// ── Start ─────────────────────────────────────────────────────────────────────

process.on("SIGINT", async () => { await disconnect(); process.exit(0); });
process.on("SIGTERM", async () => { await disconnect(); process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
