import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { HOSTED_ACTIONS } from "./hosted-policy.js";

type HostedTool = {
    title: string;
    description: string;
    annotations: Required<Pick<ToolAnnotations, "readOnlyHint" | "openWorldHint" | "destructiveHint">>;
    omitFields?: readonly string[];
};

const entry = (title: string, description: string, readOnlyHint: boolean, openWorldHint = false,
    destructiveHint = false, omitFields?: readonly string[]): HostedTool => ({
    title, description, annotations: { readOnlyHint, openWorldHint, destructiveHint }, omitFields,
});

// Hints describe every action exposed by each multiplexed hosted tool. A lookup
// that can also queue a job or populate a persistent cache is not read-only.
export const HOSTED_TOOL_CATALOG: Record<string, HostedTool> = {
    report_issue: entry("Prepare a ModLens issue", "Prepare a sanitized GitHub issue draft and filing instructions. This tool never publishes the issue.", true),
    runtime: entry("Plan Minecraft runtime actions", "Return instructions for running the local Minecraft runtime helper. Hosted calls do not execute commands on the user's computer.", true),
    mod_license: entry("Check mod source license", "Check version-specific mod license evidence or prepare a local decompilation plan. The check may retrieve and cache license evidence; a local plan does not execute.", false, true),
    mod: entry("Analyze indexed mods", "Search indexed mods, dependencies, graphs and licensed source. Source is returned only when the artifact license allows hosted access; reads may prepare local server caches.", false, true, false,
        ["jarPath", "skipSource", "force", "directory", "indexClasses", "replace", "backend", "chunkIndex", "nodes", "edges", "outputDir", "modVersion", "targetType", "targetId", "targetVersion", "targetLoader", "targetMcVersion", "model", "bundlePath", "contributor", "note", "autoEmbed", "autoGraph"]),
    mod_bytecode: entry("Analyze mod bytecode", "Inspect indexed mod classes, references and bounded bytecode. Bytecode access checks the artifact license; some comparisons may cache results.", false, true),
    mod_mixins: entry("Analyze mod mixins", "Find mixin targets, access changes and cross-mod conflicts in indexed mods.", true),
    platform: entry("Search mod platforms", "Search Modrinth and CurseForge metadata and check indexed mods for updates. Some lookups fetch and cache provider artifacts.", false, true),
    modpacks_ch: entry("Search modpacks and mods", "Search and inspect modpack and mod metadata through modpacks.ch. Some lookups fetch and cache provider artifacts.", false, true),
    mc_versions: entry("List Minecraft and loader versions", "List Minecraft, Forge, NeoForge and Fabric versions from provider metadata, which may be cached.", false, true),
    mc_source: entry("Analyze Minecraft classes", "Find Minecraft classes, members, references and compatibility facts. Public OAuth access returns source locations and status, not Minecraft source text or bytecode; calls can queue private indexing.", false, true),
    mappings: entry("Look up Minecraft mappings", "Translate Minecraft symbols and read Parchment parameter documentation. Mapping data may be fetched and cached.", false, true, false,
        ["inputJar", "outputJar", "toMapping"]),
    docs: entry("Search modding documentation", "Find and read modding documentation; missing documents may be fetched and cached.", false, true),
    primers: entry("Read migration primers", "Search and read Minecraft and loader migration guides; missing guide content may be fetched and cached.", false, true),
    mc_registry: entry("Look up Minecraft registries", "Read Minecraft registry names and metadata from indexed version data, fetching provider data when needed.", false, true),
    mc_data: entry("Inspect Minecraft data", "Read Minecraft recipes, tags, assets and other structured game data from mcmeta; provider data may be fetched and cached.", false, true),
    mc_files: entry("Read Minecraft data files", "Read and compare Minecraft data and asset files supplied by mcmeta; provider data may be fetched and cached.", false, true),
    mod_jar: entry("Inspect mod JAR metadata", "Read bounded metadata, configs, language entries and registry data from indexed mod JARs; some extracted data may be cached.", false),
    mod_data: entry("Inspect mod data", "Read and compare structured data from indexed mod JARs; extracted data may be cached.", false),
    mod_tags: entry("Analyze mod tags", "Browse indexed mod tags, contributors and conflicts.", true),
    mixin_scan: entry("Scan mixin conflicts", "Analyze mixin targets and conflicts across indexed mods.", true),
    gradle: entry("Analyze Gradle files", "Read indexed Gradle dependencies and compare build files across mods.", true),
    project: entry("Upload or inspect a private project", "Upload a Gradle environment or inspect a private snapshot using its project key. Upload and abort change stored data; abort can discard an unfinished upload.", false, false, true,
        ["bundlePath"]),
    reports: entry("Generate compatibility reports", "Generate a Markdown compatibility report in the response; hosted access cannot write a report to the server filesystem.", true, false, false,
        ["savePath"]),
    pack_tools: entry("Analyze a modpack", "Analyze indexed modpack assets, data, sidedness, complexity, changes and health.", true, false, false,
        ["scriptsDir", "configDir"]),
    analyze_crash_log: entry("Analyze a crash log", "Analyze a supplied Minecraft crash log against indexed mods; analysis may fetch and cache provider metadata.", false, true),
    find_missing_deps: entry("Find missing mod dependencies", "Find declared dependencies not satisfied by the indexed mods.", true),
};

export function hostedToolMetadata(name: string): HostedTool {
    const metadata = HOSTED_TOOL_CATALOG[name];
    if (!metadata) throw new Error(`Missing hosted tool metadata: ${name}`);
    return metadata;
}

// Keep the policy allowlist and the advertised catalog in lockstep.
for (const name of Object.keys(HOSTED_ACTIONS)) hostedToolMetadata(name);
for (const name of Object.keys(HOSTED_TOOL_CATALOG)) {
    if (!HOSTED_ACTIONS[name]) throw new Error(`Hosted tool metadata has no policy entry: ${name}`);
}
