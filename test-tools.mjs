/**
 * modlens-mcp functional test
 * Spins up the server via StdioClientTransport, calls every tool once,
 * and reports PASS/FAIL per tool+action.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "dist", "server.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env: { ...process.env },
});

const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`\nRegistered tools: ${tools.tools.length}`);
console.log(tools.tools.map(t => t.name).join(", "), "\n");

let passed = 0;
let failed = 0;
const errors = [];

async function call(toolName, args, label) {
  try {
    const r = await client.callTool({ name: toolName, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    if (text.includes('"error"') && !text.includes('"results"') && text.length < 300) {
      throw new Error(text.slice(0, 200));
    }
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.log(`  ❌ ${label}: ${msg.slice(0, 120)}`);
    errors.push({ label, msg });
    failed++;
  }
}

// ── mod ────────────────────────────────────────────────────────────────────
console.log("=== mod ===");
await call("mod", { action: "stats" }, "mod/stats");
await call("mod", { action: "list", limit: 3 }, "mod/list");
await call("mod", { action: "search", query: "ae2", limit: 3 }, "mod/search");
await call("mod", { action: "version_conflicts" }, "mod/version_conflicts");
await call("mod", { action: "dep_graph" }, "mod/dep_graph");
await call("mod", { action: "source_urls" }, "mod/source_urls");
await call("mod", { action: "reindex" }, "mod/reindex");

// get first mod id
let firstModId;
try {
  const r = await client.callTool({ name: "mod", arguments: { action: "list", limit: 1 } });
  const data = JSON.parse(r.content[0].text);
  firstModId = data?.[0]?.id ?? data?.mods?.[0]?.id;
} catch {}

if (firstModId) {
  await call("mod", { action: "get", modId: firstModId }, `mod/get (id=${firstModId})`);
  await call("mod", { action: "dependencies", modId: firstModId }, `mod/dependencies`);
  await call("mod", { action: "decompile_status", dbId: firstModId }, `mod/decompile_status`);
  await call("mod", { action: "source", dbId: firstModId }, `mod/source`);
} else {
  console.log("  ⚠️  No mods in DB — skipping mod/get, dependencies, source");
}

// ── mod_bytecode ──────────────────────────────────────────────────────────
console.log("\n=== mod_bytecode ===");
if (firstModId) {
  await call("mod_bytecode", { action: "search_class", dbId: firstModId, query: "Mixin" }, "mod_bytecode/search_class");
  await call("mod_bytecode", { action: "find_implementors", target: "net/minecraft/world/entity/LivingEntity", limit: 5 }, "mod_bytecode/find_implementors");
} else {
  console.log("  ⚠️  No mods — skipping mod_bytecode tests");
}

// ── mod_mixins ────────────────────────────────────────────────────────────
console.log("\n=== mod_mixins ===");
await call("mod_mixins", { action: "conflicts", targetClass: "net/minecraft/world/entity/LivingEntity" }, "mod_mixins/conflicts");
if (firstModId) {
  await call("mod_mixins", { action: "targets", modId: firstModId }, "mod_mixins/targets");
}

// ── platform ──────────────────────────────────────────────────────────────
console.log("\n=== platform ===");
await call("platform", { action: "batch_sync", syncModrinth: false, syncCurseforge: false, limit: 1 }, "platform/batch_sync (dry)");

// ── mc_versions ───────────────────────────────────────────────────────────
console.log("\n=== mc_versions ===");
await call("mc_versions", { action: "list_mc", type: "release" }, "mc_versions/list_mc");
await call("mc_versions", { action: "list_neoforge", mcVersion: "1.21", limit: 5 }, "mc_versions/list_neoforge");
await call("mc_versions", { action: "list_fabric", mcVersion: "1.21", limit: 5 }, "mc_versions/list_fabric");

// ── mc_registry ───────────────────────────────────────────────────────────
console.log("\n=== mc_registry ===");
await call("mc_registry", { action: "mcmeta_versions", filter: "release" }, "mc_registry/mcmeta_versions");
await call("mc_registry", { action: "registries", version: "26.1.2" }, "mc_registry/registries");
await call("mc_registry", { action: "registry_entries", registry: "item", version: "26.1.2" }, "mc_registry/registry_entries(item)");
await call("mc_registry", { action: "blocks", version: "26.1.2" }, "mc_registry/blocks");
await call("mc_registry", { action: "sounds", version: "26.1.2" }, "mc_registry/sounds");
await call("mc_registry", { action: "item_components", version: "26.1.2" }, "mc_registry/item_components");
await call("mc_registry", { action: "commands", version: "26.1.2" }, "mc_registry/commands");

// ── mc_data ───────────────────────────────────────────────────────────────
console.log("\n=== mc_data ===");
await call("mc_data", { action: "tags", version: "26.1.2", registry: "block" }, "mc_data/tags(block)");
await call("mc_data", { action: "find_tags_for", entry: "minecraft:iron_ore", registry: "block", version: "26.1.2" }, "mc_data/find_tags_for");
await call("mc_data", { action: "recipes", version: "26.1.2", type: "crafting_shaped" }, "mc_data/recipes");
await call("mc_data", { action: "find_recipes_for", item: "iron_ingot", version: "26.1.2" }, "mc_data/find_recipes_for");
await call("mc_data", { action: "loot_tables", version: "26.1.2" }, "mc_data/loot_tables");
await call("mc_data", { action: "lang", version: "26.1.2", filter: "iron", limit: 5 }, "mc_data/lang");
await call("mc_data", { action: "blockstate", version: "26.1.2", block: "stone" }, "mc_data/blockstate");
await call("mc_data", { action: "biomes", version: "26.1.2" }, "mc_data/biomes");
await call("mc_data", { action: "damage_types", version: "26.1.2" }, "mc_data/damage_types");
await call("mc_data", { action: "enchantments", version: "26.1.2" }, "mc_data/enchantments");
await call("mc_data", { action: "advancements", version: "26.1.2" }, "mc_data/advancements");
await call("mc_data", { action: "structures", version: "26.1.2" }, "mc_data/structures");
await call("mc_data", { action: "particles", version: "26.1.2" }, "mc_data/particles");
await call("mc_data", { action: "entity_attributes", version: "26.1.2" }, "mc_data/entity_attributes");

// ── mc_files ──────────────────────────────────────────────────────────────
console.log("\n=== mc_files ===");
await call("mc_files", { action: "list_files", dirPath: "minecraft/recipes", version: "26.1.2", branch: "data" }, "mc_files/list_files");
await call("mc_files", { action: "get_data", filePath: "data/minecraft/recipe/crafting_table.json", version: "26.1.2" }, "mc_files/get_data");
await call("mc_files", { action: "changelog", version: "26.1.2" }, "mc_files/changelog");
await call("mc_files", { action: "atlas", version: "26.1.2" }, "mc_files/atlas");

// ── mappings ──────────────────────────────────────────────────────────────
console.log("\n=== mappings ===");
await call("mappings", { action: "list_parchment", mcVersion: "1.21.1" }, "mappings/list_parchment");

// ── docs ──────────────────────────────────────────────────────────────────
console.log("\n=== docs ===");
await call("docs", { action: "list", limit: 5 }, "docs/list");
await call("docs", { action: "search", query: "mixin" }, "docs/search");

// ── primers ───────────────────────────────────────────────────────────────
console.log("\n=== primers ===");
await call("primers", { action: "list", limit: 5 }, "primers/list");
await call("primers", { action: "search", query: "neoforge" }, "primers/search");

// ── mod_tags ──────────────────────────────────────────────────────────────
console.log("\n=== mod_tags ===");
await call("mod_tags", { action: "namespaces" }, "mod_tags/namespaces");
await call("mod_tags", { action: "find_conflicts" }, "mod_tags/find_conflicts");
await call("mod_tags", { action: "search", query: "ores", limit: 5 }, "mod_tags/search");

// ── mixin_scan ────────────────────────────────────────────────────────────
console.log("\n=== mixin_scan ===");
await call("mixin_scan", { action: "list_mods" }, "mixin_scan/list_mods");
await call("mixin_scan", { action: "hotspots", top: 5 }, "mixin_scan/hotspots");
await call("mixin_scan", { action: "conflict_matrix", minConflicts: 2 }, "mixin_scan/conflict_matrix");

// ── gradle ────────────────────────────────────────────────────────────────
console.log("\n=== gradle ===");
await call("gradle", { action: "compare_deps" }, "gradle/compare_deps");

// ── mod_jar ───────────────────────────────────────────────────────────────
console.log("\n=== mod_jar ===");
if (firstModId) {
  await call("mod_jar", { action: "list_files", modId: firstModId }, "mod_jar/list_files");
  await call("mod_jar", { action: "lang", modId: firstModId, limit: 5 }, "mod_jar/lang");
  await call("mod_jar", { action: "registry_entries", modId: firstModId, type: "item", limit: 5 }, "mod_jar/registry_entries");
} else {
  console.log("  ⚠️  No mods — skipping mod_jar tests");
}

// ── mod_data ──────────────────────────────────────────────────────────────
console.log("\n=== mod_data ===");
if (firstModId) {
  await call("mod_data", { action: "list", type: "recipe", modId: firstModId }, "mod_data/list/recipe");
  await call("mod_data", { action: "list", type: "loot_table", modId: firstModId }, "mod_data/list/loot_table");
  await call("mod_data", { action: "list", type: "advancement", modId: firstModId }, "mod_data/list/advancement");
} else {
  console.log("  ⚠️  No mods — skipping mod_data tests");
}

// ── reports ───────────────────────────────────────────────────────────────
console.log("\n=== reports ===");
await call("reports", { report: "version_conflicts" }, "reports/version_conflicts");
await call("reports", { report: "mixin_conflicts" }, "reports/mixin_conflicts");
await call("reports", { report: "tag_conflicts" }, "reports/tag_conflicts");
await call("reports", { report: "gradle_deps" }, "reports/gradle_deps");

// ── mc_source (read-only checks, no decompile) ────────────────────────────
console.log("\n=== mc_source ===");
await call("mc_source", { action: "decompile_status", version: "26.1.2" }, "mc_source/decompile_status");

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (errors.length) {
  console.log("\nFailed tests:");
  for (const { label, msg } of errors) {
    console.log(`  ❌ ${label}`);
    console.log(`     ${msg}`);
  }
}

await client.close();
process.exit(failed > 0 ? 1 : 0);
