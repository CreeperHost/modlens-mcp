/**
 * MCP tools for browsing vanilla Minecraft data/asset files via misode/mcmeta.
 *
 * Covers: tags, recipes, loot tables, lang, blockstates, models, biomes,
 *         damage types, enchantments — all cached to ~/.modlens-cache/mcmeta/.
 *
 * Data paths follow Minecraft's pack structure:
 *   data branch  → data/minecraft/<type>/<id>.json
 *   assets-json  → assets/minecraft/<type>/<id>.json
 */
import { readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { CACHE_ROOT, exists, ensureDir } from "../cache.js";
import { resolveModRef } from "../repositories/mod.js";
import { searchSource } from "./source.js";

const RAW_BASE     = "https://raw.githubusercontent.com/misode/mcmeta";
const MCMETA_CACHE = join(CACHE_ROOT, "mcmeta");

// ── Internal helpers ──────────────────────────────────────────────────────────

function mcmetaCachePath(version: string, branch: string, filePath: string): string {
    return join(MCMETA_CACHE, version, branch, filePath);
}

async function fetchMcmetaJson<T>(ref: string, filePath: string): Promise<T> {
    const url = `${RAW_BASE}/${ref}/${filePath}`;
    const [version, branch] = ref.includes("-")
        ? ref.split(/-(.+)/) as [string, string]
        : ["_latest", ref];
    const cachePath = mcmetaCachePath(version, branch, filePath);

    if (await exists(cachePath)) {
        return JSON.parse((await readFile(cachePath)).toString("utf8")) as T;
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`mcmeta fetch failed: ${res.status} — ${url}`);
    const text = await res.text();
    await ensureDir(cachePath);
    await writeFile(cachePath, Buffer.from(text));
    return JSON.parse(text) as T;
}

function versionRef(version: string | undefined, branch: string): string {
    return version ? `${version}-${branch}` : branch;
}

type DirEntry = { name: string; type: "file" | "dir" };

/**
 * List files/dirs in a mcmeta branch directory via the GitHub Contents API.
 * Result is cached as _dir_index.json inside the matching cache directory.
 */
async function listMcmetaDir(
    version: string,
    branch: string,
    path: string,
): Promise<DirEntry[]> {
    const cacheDir  = mcmetaCachePath(version, branch, path);
    const indexPath = join(cacheDir, "_dir_index.json");

    if (await exists(indexPath)) {
        return JSON.parse((await readFile(indexPath)).toString("utf8")) as DirEntry[];
    }

    // Try local cache dir listing first (may already be populated by prior fetches)
    if (await exists(cacheDir)) {
        try {
            const dirEntries = await readdir(cacheDir, { withFileTypes: true });
            const entries: DirEntry[] = dirEntries
                .filter(e => e.name !== "_dir_index.json")
                .map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
            if (entries.length > 0) {
                await writeFile(indexPath, JSON.stringify(entries, null, 2));
                return entries;
            }
        } catch { /* fall through to API */ }
    }

    const apiUrl = `https://api.github.com/repos/misode/mcmeta/contents/${path}?ref=${version}-${branch}`;
    const res = await fetch(apiUrl, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (!res.ok) throw new Error(`GitHub contents API ${res.status} — ${apiUrl}`);
    const items = await res.json() as Array<{ name: string; type: string }>;
    const entries: DirEntry[] = items.map(i => ({ name: i.name, type: i.type === "dir" ? "dir" : "file" }));

    await ensureDir(indexPath);
    await writeFile(indexPath, JSON.stringify(entries, null, 2));
    return entries;
}

// ── Tags ──────────────────────────────────────────────────────────────────────

/**
 * Browse vanilla MC tags.
 * - No registry: list all tag registries (block, item, entity_type, …)
 * - registry only: list all tag IDs in that registry
 * - registry + tagId: return the full tag JSON (values array)
 */
export async function getMcTags(
    version?: string,
    registry?: string,
    tagId?: string,
    namespace = "minecraft",
): Promise<object> {
    const v = version ?? "26.1.2";
    const branch = "data";

    if (registry && tagId) {
        const path = `data/${namespace}/tags/${registry}/${tagId}.json`;
        try {
            const data = await fetchMcmetaJson<unknown>(versionRef(v, branch), path);
            return { version: v, namespace, registry, tagId, ...(data as object) };
        } catch (err) {
            return { version: v, namespace, registry, tagId, error: String(err) };
        }
    }

    if (registry) {
        const path = `data/${namespace}/tags/${registry}`;
        try {
            const entries = await listMcmetaDir(v, branch, path);
            const tags = entries
                .filter(e => e.type === "file" && e.name.endsWith(".json"))
                .map(e => e.name.replace(".json", ""));
            return { version: v, namespace, registry, count: tags.length, tags };
        } catch (err) {
            return { version: v, namespace, registry, error: String(err) };
        }
    }

    // List all tag registries
    const path = `data/${namespace}/tags`;
    try {
        const entries = await listMcmetaDir(v, branch, path);
        const registries = entries.filter(e => e.type === "dir").map(e => e.name);
        return { version: v, namespace, registries };
    } catch (err) {
        return { version: v, namespace, error: String(err) };
    }
}

/**
 * Reverse tag lookup: find every tag in a registry whose values list contains
 * the given entry (e.g. "minecraft:iron_ore" in the "block" registry).
 */
export async function findTagsForEntry(
    entry: string,
    registry: string,
    version?: string,
    namespace = "minecraft",
): Promise<object> {
    const v = version ?? "26.1.2";
    const normalizedEntry = entry.includes(":") ? entry : `minecraft:${entry}`;

    const listResult = await getMcTags(v, registry, undefined, namespace) as { tags?: string[] };
    const tagIds = listResult.tags ?? [];

    const results = await Promise.all(
        tagIds.map(async (tagId) => {
            try {
                const data = await fetchMcmetaJson<{ values?: unknown[] }>(
                    versionRef(v, "data"),
                    `data/${namespace}/tags/${registry}/${tagId}.json`,
                );
                const values = (data.values ?? []) as unknown[];
                const flat = values.map(val =>
                    typeof val === "string" ? val : (val as { id?: string }).id ?? "",
                );
                if (flat.some(e => e === normalizedEntry || e === entry)) {
                    return { tag: `#${namespace}:${tagId}`, values };
                }
            } catch { /* skip broken tags */ }
            return null;
        }),
    );
    const matchingTags = results.filter((r): r is { tag: string; values: unknown[] } => r !== null);

    return { version: v, namespace, registry, entry: normalizedEntry, found: matchingTags.length, tags: matchingTags };
}

// ── Recipes ───────────────────────────────────────────────────────────────────

/**
 * List vanilla recipes, optionally filtered by recipe type or output item.
 * When filtering by outputItem or type, each recipe file is loaded (results cached).
 */
export async function listRecipes(
    version?: string,
    type?: string,
    outputItem?: string,
): Promise<object> {
    const v = version ?? "26.1.2";
    try {
        const entries = await listMcmetaDir(v, "data", "data/minecraft/recipe");
        const ids = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => e.name.replace(".json", ""));

        if (!type && !outputItem) {
            return { version: v, count: ids.length, recipes: ids };
        }

        // Load all recipes concurrently and apply filters
        type RecipeJson = { type?: string; result?: unknown; output?: unknown };
        const fetched = await Promise.all(
            ids.map(async (id) => {
                try {
                    const data = await fetchMcmetaJson<RecipeJson>(
                        versionRef(v, "data"),
                        `data/minecraft/recipe/${id}.json`,
                    );
                    const rType = (data.type ?? "").replace("minecraft:", "");
                    if (type && !rType.includes(type)) return null;
                    if (outputItem) {
                        const resultStr = JSON.stringify(data.result ?? data.output ?? "");
                        if (!resultStr.includes(outputItem.replace("minecraft:", ""))) return null;
                    }
                    return { id, recipeType: rType, result: data.result ?? data.output };
                } catch { return null; }
            }),
        );
        const results = fetched.filter((r): r is { id: string; recipeType: string; result: unknown } => r !== null);
        return { version: v, count: results.length, recipes: results };
    } catch (err) {
        return { version: v, error: String(err) };
    }
}

/**
 * Get the full JSON for a specific vanilla recipe by its ID (e.g. "crafting_table").
 */
export async function getRecipe(version?: string, recipeId?: string): Promise<object> {
    if (!recipeId) return { error: "recipeId is required" };
    const v = version ?? "26.1.2";
    const id = recipeId.replace("minecraft:", "");
    try {
        const data = await fetchMcmetaJson<unknown>(
            versionRef(v, "data"),
            `data/minecraft/recipe/${id}.json`,
        );
        return { version: v, id, data };
    } catch (err) {
        return { version: v, id, error: String(err) };
    }
}

// ── Loot Tables ───────────────────────────────────────────────────────────────

/**
 * List vanilla loot tables.
 * - No category: list top-level categories (blocks, entities, chests, gameplay, …)
 * - category given: list all tables in that category
 */
export async function listLootTables(version?: string, category?: string): Promise<object> {
    const v = version ?? "26.1.2";
    const basePath = "data/minecraft/loot_table";

    if (category) {
        try {
            const entries = await listMcmetaDir(v, "data", `${basePath}/${category}`);
            const tables = entries
                .filter(e => e.type === "file" && e.name.endsWith(".json"))
                .map(e => `${category}/${e.name.replace(".json", "")}`);
            return { version: v, category, count: tables.length, lootTables: tables };
        } catch (err) {
            return { version: v, category, error: String(err) };
        }
    }

    try {
        const entries = await listMcmetaDir(v, "data", basePath);
        const dirs  = entries.filter(e => e.type === "dir").map(e => e.name);
        const files = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => e.name.replace(".json", ""));
        return { version: v, categories: dirs, rootLootTables: files };
    } catch (err) {
        return { version: v, error: String(err) };
    }
}

/**
 * Get the full JSON for a specific vanilla loot table.
 * path examples: "blocks/iron_ore", "chests/dungeon", "entities/creeper"
 */
export async function getLootTable(version?: string, path?: string): Promise<object> {
    if (!path) return { error: "path is required" };
    const v = version ?? "26.1.2";
    const fullPath = path.startsWith("data/")
        ? path
        : `data/minecraft/loot_table/${path}${path.endsWith(".json") ? "" : ".json"}`;
    try {
        const data = await fetchMcmetaJson<unknown>(versionRef(v, "data"), fullPath);
        return { version: v, path, data };
    } catch (err) {
        return { version: v, path, error: String(err) };
    }
}

// ── Lang / Translations ───────────────────────────────────────────────────────

/**
 * Search vanilla en_us.json translation keys/values.
 * filter: substring matched against both key and value (case-insensitive).
 * limit: max number of results to return (default 100).
 */
export async function getLangEntries(
    version?: string,
    filter?: string,
    limit = 100,
): Promise<object> {
    const v = version ?? "26.1.2";
    try {
        const lang = await fetchMcmetaJson<Record<string, string>>(
            versionRef(v, "assets-json"),
            "assets/minecraft/lang/en_us.json",
        );

        if (!filter) {
            const entries = Object.entries(lang);
            return {
                version: v,
                total: entries.length,
                shown: Math.min(entries.length, limit),
                entries: Object.fromEntries(entries.slice(0, limit)),
            };
        }

        const lower = filter.toLowerCase();
        const matched = Object.entries(lang).filter(
            ([k, val]) => k.toLowerCase().includes(lower) || val.toLowerCase().includes(lower),
        );
        return {
            version: v,
            filter,
            count: matched.length,
            entries: Object.fromEntries(matched.slice(0, limit)),
        };
    } catch (err) {
        return { version: v, error: String(err) };
    }
}

// ── Blockstates & Models ──────────────────────────────────────────────────────

/**
 * Get the blockstate JSON for a vanilla block (variant → model path mappings).
 * block: e.g. "stone", "oak_door", "minecraft:grass_block"
 */
export async function getBlockstate(version?: string, block?: string): Promise<object> {
    if (!block) return { error: "block is required" };
    const v = version ?? "26.1.2";
    const id = block.replace("minecraft:", "");
    try {
        const data = await fetchMcmetaJson<unknown>(
            versionRef(v, "assets-json"),
            `assets/minecraft/blockstates/${id}.json`,
        );
        return { version: v, block: id, data };
    } catch (err) {
        return { version: v, block: id, error: String(err) };
    }
}

/**
 * Get a vanilla model JSON and follow its parent chain.
 * modelPath: e.g. "block/stone", "item/iron_sword", "block/cube_all"
 * resolveParents: if true (default), recursively fetches parent models and merges texture keys.
 */
export async function getMcModel(
    version?: string,
    modelPath?: string,
    resolveParents = true,
): Promise<object> {
    if (!modelPath) return { error: "modelPath is required" };
    const v = version ?? "26.1.2";
    const normalPath = modelPath.endsWith(".json") ? modelPath : `${modelPath}.json`;
    const fullPath = normalPath.startsWith("assets/") ? normalPath : `assets/minecraft/models/${normalPath}`;

    type ModelJson = { parent?: string; textures?: Record<string, string>; elements?: unknown[]; display?: unknown };

    try {
        const root = await fetchMcmetaJson<ModelJson>(versionRef(v, "assets-json"), fullPath);

        if (!resolveParents || !root.parent) {
            return { version: v, modelPath, data: root };
        }

        // Walk parent chain, collecting texture overrides
        const chain: Array<{ path: string; data: ModelJson }> = [{ path: fullPath, data: root }];
        let current = root;
        const seen = new Set<string>([fullPath]);

        while (current.parent) {
            const parentPath = current.parent.includes(":")
                ? `assets/${current.parent.replace(":", "/models/")}.json`
                : `assets/minecraft/models/${current.parent}.json`;
            if (seen.has(parentPath)) break;
            seen.add(parentPath);
            try {
                const parentData = await fetchMcmetaJson<ModelJson>(versionRef(v, "assets-json"), parentPath);
                chain.push({ path: parentPath, data: parentData });
                current = parentData;
            } catch { break; }
        }

        // Merge: child textures win; collect all unique elements
        const mergedTextures: Record<string, string> = {};
        for (const { data } of [...chain].reverse()) {
            Object.assign(mergedTextures, data.textures ?? {});
        }

        return {
            version: v,
            modelPath,
            data: root,
            parentChain: chain.slice(1).map(c => c.path),
            mergedTextures,
        };
    } catch (err) {
        return { version: v, modelPath, error: String(err) };
    }
}

// ── Biomes ────────────────────────────────────────────────────────────────────

/**
 * List all vanilla biomes for a MC version.
 */
export async function listBiomes(version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    try {
        const entries = await listMcmetaDir(v, "data", "data/minecraft/worldgen/biome");
        const biomes = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => `minecraft:${e.name.replace(".json", "")}`);
        return { version: v, count: biomes.length, biomes };
    } catch (err) {
        return { version: v, error: String(err) };
    }
}

/**
 * Get the full worldgen biome JSON for a specific biome.
 * biomeId: e.g. "minecraft:desert", "badlands", "deep_dark"
 */
export async function getBiome(version?: string, biomeId?: string): Promise<object> {
    if (!biomeId) return { error: "biomeId is required" };
    const v = version ?? "26.1.2";
    const id = biomeId.replace("minecraft:", "");
    try {
        const data = await fetchMcmetaJson<unknown>(
            versionRef(v, "data"),
            `data/minecraft/worldgen/biome/${id}.json`,
        );
        return { version: v, biome: `minecraft:${id}`, data };
    } catch (err) {
        return { version: v, biome: id, error: String(err) };
    }
}

// ── Damage Types ──────────────────────────────────────────────────────────────

/**
 * List all vanilla damage types with their full JSON definitions.
 * Returns the complete map: id → { message_id, scaling, exhaustion, effects?, death_message_type? }
 */
export async function listDamageTypes(version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    try {
        const entries = await listMcmetaDir(v, "data", "data/minecraft/damage_type");
        const ids = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => e.name.replace(".json", ""));

        const damageTypes: Record<string, unknown> = {};
        await Promise.all(ids.map(async id => {
            try {
                damageTypes[`minecraft:${id}`] = await fetchMcmetaJson<unknown>(
                    versionRef(v, "data"),
                    `data/minecraft/damage_type/${id}.json`,
                );
            } catch { /* skip */ }
        }));
        return { version: v, count: ids.length, damageTypes };
    } catch (err) {
        return { version: v, error: String(err) };
    }
}

// ── Enchantments ──────────────────────────────────────────────────────────────

/**
 * List all vanilla enchantments for a MC version.
 */
export async function listEnchantments(version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    try {
        const entries = await listMcmetaDir(v, "data", "data/minecraft/enchantment");
        const enchantments = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => `minecraft:${e.name.replace(".json", "")}`);
        return { version: v, count: enchantments.length, enchantments };
    } catch (err) {
        return { version: v, error: String(err) };
    }
}

/**
 * Get the full JSON definition of a vanilla enchantment.
 * id: e.g. "minecraft:sharpness", "looting", "protection"
 */
export async function getEnchantment(version?: string, id?: string): Promise<object> {
    if (!id) return { error: "id is required" };
    const v = version ?? "26.1.2";
    const normalId = id.replace("minecraft:", "");
    try {
        const data = await fetchMcmetaJson<unknown>(
            versionRef(v, "data"),
            `data/minecraft/enchantment/${normalId}.json`,
        );
        return { version: v, enchantment: `minecraft:${normalId}`, data };
    } catch (err) {
        return { version: v, enchantment: id, error: String(err) };
    }
}

// ── Advancements ──────────────────────────────────────────────────────────────

/**
 * List vanilla advancements, optionally filtered by category tab.
 * category: e.g. "story", "nether", "end", "adventure", "husbandry"
 */
export async function listAdvancements(version?: string, category?: string): Promise<object> {
    const v = version ?? "26.1.2";
    const basePath = "data/minecraft/advancement";

    if (category) {
        try {
            const entries = await listMcmetaDir(v, "data", `${basePath}/${category}`);
            const advancements = entries
                .filter(e => e.type === "file" && e.name.endsWith(".json"))
                .map(e => `${category}/${e.name.replace(".json", "")}`);
            return { version: v, category, count: advancements.length, advancements };
        } catch (err) {
            return { version: v, category, error: String(err) };
        }
    }

    try {
        const entries = await listMcmetaDir(v, "data", basePath);
        const dirs  = entries.filter(e => e.type === "dir").map(e => e.name);
        const files = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => e.name.replace(".json", ""));
        return { version: v, categories: dirs, rootAdvancements: files };
    } catch (err) {
        return { version: v, error: String(err) };
    }
}

/**
 * Get the full JSON for a specific vanilla advancement.
 * id: e.g. "story/mine_stone", "nether/root", "adventure/kill_a_mob"
 */
export async function getAdvancement(version?: string, id?: string): Promise<object> {
    if (!id) return { error: "id is required" };
    const v = version ?? "26.1.2";
    const fullPath = id.startsWith("data/")
        ? id
        : `data/minecraft/advancement/${id}${id.endsWith(".json") ? "" : ".json"}`;
    try {
        const data = await fetchMcmetaJson<unknown>(versionRef(v, "data"), fullPath);
        return { version: v, id, data };
    } catch (err) {
        return { version: v, id, error: String(err) };
    }
}

// ── Reverse recipe lookup ─────────────────────────────────────────────────────

/**
 * Find all recipes whose result/output contains the given item.
 * item: e.g. "iron_ingot", "minecraft:iron_ingot"
 */
export async function findRecipesForItem(item: string, version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    return listRecipes(v, undefined, item);
}

// ── Block/item model tree ─────────────────────────────────────────────────────

type ModelJson = { parent?: string; textures?: Record<string, string>; elements?: unknown[]; display?: unknown; overrides?: unknown[] };

/**
 * Resolve the full model JSON inheritance chain for a block or item model.
 * Follows parent references until a model with no parent (or a builtin) is reached.
 * modelPath: e.g. "block/stone", "item/diamond_sword"
 */
export async function getModelTree(modelPath: string, version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    const chain: Array<{ path: string; data: ModelJson }> = [];
    const visited = new Set<string>();

    let current = modelPath.replace(/^minecraft:/, "");
    // Normalise — add block/ prefix if bare id with no slash
    if (!current.includes("/")) current = `block/${current}`;

    while (current && !visited.has(current)) {
        visited.add(current);
        const filePath = `assets/minecraft/models/${current}.json`;
        try {
            const data = await fetchMcmetaJson<ModelJson>(versionRef(v, "assets-json"), filePath);
            chain.push({ path: current, data });
            const parent = data.parent?.replace(/^minecraft:/, "");
            if (!parent || parent.startsWith("builtin/")) break;
            current = parent;
        } catch {
            chain.push({ path: current, data: { parent: undefined }, });
            break;
        }
    }

    // Merge textures up the chain (child wins)
    const mergedTextures: Record<string, string> = {};
    for (const node of [...chain].reverse()) {
        Object.assign(mergedTextures, node.data.textures ?? {});
    }

    return { version: v, modelPath, chainLength: chain.length, mergedTextures, chain };
}

// ── Worldgen: structures ──────────────────────────────────────────────────────

/**
 * List all vanilla worldgen structures.
 * category: optionally scope to a sub-folder (most structures are flat, so usually omit)
 */
export async function listStructures(version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    const basePath = "data/minecraft/worldgen/structure";
    try {
        const entries = await listMcmetaDir(v, "data", basePath);
        const structures = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => `minecraft:${e.name.replace(".json", "")}`);
        return { version: v, count: structures.length, structures };
    } catch (err) {
        return { version: v, error: String(err) };
    }
}

/**
 * Get the full JSON for a vanilla worldgen structure.
 * id: e.g. "minecraft:village_plains", "bastion_remnant"
 */
export async function getStructureData(id: string, version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    const normalId = id.replace("minecraft:", "");
    try {
        const data = await fetchMcmetaJson<unknown>(
            versionRef(v, "data"),
            `data/minecraft/worldgen/structure/${normalId}.json`,
        );
        return { version: v, structure: `minecraft:${normalId}`, data };
    } catch (err) {
        return { version: v, structure: id, error: String(err) };
    }
}

// ── Particles ─────────────────────────────────────────────────────────────────

/**
 * List all vanilla particle types registered in the particle registry.
 * Returns both the registry entry names and the particle description JSONs
 * where available (assets/minecraft/particles/<id>.json).
 */
export async function getMcParticles(version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    // Particle descriptions live in assets branch
    const basePath = "assets/minecraft/particles";
    try {
        const entries = await listMcmetaDir(v, "assets-json", basePath);
        const particles = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => `minecraft:${e.name.replace(".json", "")}`);
        return { version: v, count: particles.length, particles };
    } catch {
        // Fall back to registry summary from mc-registries-style data
        return { version: v, note: "Particle description files not available for this version. Use get_mc_registry_entries with registry=particle_type.", particles: [] };
    }
}

/**
 * Get the description JSON for a specific particle type.
 * id: e.g. "minecraft:dust", "explosion"
 */
export async function getParticleData(id: string, version?: string): Promise<object> {
    const v = version ?? "26.1.2";
    const normalId = id.replace("minecraft:", "");
    try {
        const data = await fetchMcmetaJson<unknown>(
            versionRef(v, "assets-json"),
            `assets/minecraft/particles/${normalId}.json`,
        );
        return { version: v, particle: `minecraft:${normalId}`, data };
    } catch (err) {
        return { version: v, particle: id, error: String(err) };
    }
}

// ── Entity attributes ─────────────────────────────────────────────────────────

/**
 * Get default attributes for a vanilla or modded entity type.
 *
 * Vanilla: reads from data/minecraft/attribute/<entity>.json, falls back to a
 *          built-in defaults table for the most common entity types.
 * Modded:  provide modId to search the mod's decompiled source for
 *          `createAttributes()` / `registerAttributes()` in the entity class.
 *
 * entity: e.g. "player", "zombie", "mymod:my_creature" — omit to list all vanilla attribute files
 * modId:  DB modId string or numeric id (required for modded entities)
 */
export async function getEntityAttributes(entity?: string, version?: string, modId?: string | number): Promise<object> {
    const v = version ?? "26.1.2";

    // ── Modded entity lookup ──────────────────────────────────────────────────
    if (modId !== undefined || (entity && entity.includes(":") && !entity.startsWith("minecraft:"))) {
        // Resolve mod record
        const mod = modId !== undefined
            ? await resolveModRef(String(modId))
            : null;

        if (!mod && modId !== undefined) {
            return { error: `Mod not found: ${modId}` };
        }

        if (!entity) {
            return { error: "entity is required when looking up modded attributes." };
        }

        // If not decompiled, we can't search source
        if (!mod?.decompiled) {
            return {
                entity,
                mod: mod?.modId ?? "unknown",
                note: "Mod is not decompiled. Run decompile_mod first, then retry.",
                attributes: [],
            };
        }

        // Entity name heuristic: "mymod:my_creature" or just "my_creature"
        const entityName = entity.includes(":") ? entity.split(":")[1] : entity;
        // Convert snake_case to PascalCase class name heuristic
        const className = entityName.split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

        // Search decompiled source for createAttributes / registerAttributes in the entity class
        const [createHits, registerHits] = await Promise.all([
            searchSource(`createAttributes`, mod.id, false, 30),
            searchSource(`registerAttributes`, mod.id, false, 20),
        ]);

        // Filter hits to those in files matching the entity class name
        const classFilter = (hit: { file: string }) =>
            hit.file.toLowerCase().includes(entityName.replace(/_/g, "").toLowerCase()) ||
            hit.file.toLowerCase().includes(className.toLowerCase());

        const relevant = [
            ...createHits.filter(classFilter),
            ...registerHits.filter(classFilter),
        ];

        if (relevant.length === 0) {
            // Fallback: return all createAttributes hits from the mod
            return {
                entity,
                mod: mod.modId,
                entityClass: className,
                note: `No createAttributes() / registerAttributes() found for class '${className}'. Showing all attribute-related hits in mod — narrow by class name manually.`,
                allAttributeHits: [...createHits.slice(0, 20), ...registerHits.slice(0, 10)].map(h => ({
                    file: h.file, line: h.line, text: h.text,
                })),
            };
        }

        return {
            entity,
            mod: mod.modId,
            entityClass: className,
            source: "decompiled source search",
            note: "These are raw source snippets from createAttributes()/registerAttributes(). Attribute base values are in the method body.",
            attributeHits: relevant.map(h => ({ file: h.file, line: h.line, text: h.text })),
        };
    }

    // ── Vanilla entity lookup ─────────────────────────────────────────────────
    const basePath = "data/minecraft/attribute";

    if (entity) {
        const normalId = entity.replace("minecraft:", "");
        // Try direct attribute file for entity
        try {
            const data = await fetchMcmetaJson<unknown>(
                versionRef(v, "data"),
                `data/minecraft/attribute/${normalId}.json`,
            );
            return { version: v, entity: `minecraft:${normalId}`, source: "mcmeta data pack", data };
        } catch { /* fall through to known defaults table */ }

        // Known defaults table (most useful for modding)
        const KNOWN_DEFAULTS: Record<string, Array<{ id: string; base: number; min?: number; max?: number }>> = {
            player: [
                { id: "minecraft:max_health", base: 20 },
                { id: "minecraft:movement_speed", base: 0.1 },
                { id: "minecraft:attack_damage", base: 1 },
                { id: "minecraft:attack_speed", base: 4 },
                { id: "minecraft:armor", base: 0 },
                { id: "minecraft:armor_toughness", base: 0 },
                { id: "minecraft:knockback_resistance", base: 0 },
                { id: "minecraft:luck", base: 0 },
                { id: "minecraft:max_absorption", base: 0 },
                { id: "minecraft:follow_range", base: 32 },
                { id: "minecraft:safe_fall_distance", base: 3 },
                { id: "minecraft:fall_damage_multiplier", base: 1 },
                { id: "minecraft:jump_strength", base: 0.42 },
                { id: "minecraft:scale", base: 1 },
            ],
            zombie: [
                { id: "minecraft:max_health", base: 20 },
                { id: "minecraft:movement_speed", base: 0.23 },
                { id: "minecraft:attack_damage", base: 3 },
                { id: "minecraft:follow_range", base: 35 },
                { id: "minecraft:armor", base: 0 },
                { id: "minecraft:knockback_resistance", base: 0 },
                { id: "minecraft:spawn_reinforcements_chance", base: 0.1 },
            ],
            skeleton: [
                { id: "minecraft:max_health", base: 20 },
                { id: "minecraft:movement_speed", base: 0.25 },
                { id: "minecraft:attack_damage", base: 2 },
                { id: "minecraft:follow_range", base: 35 },
                { id: "minecraft:armor", base: 0 },
            ],
            creeper: [
                { id: "minecraft:max_health", base: 20 },
                { id: "minecraft:movement_speed", base: 0.25 },
                { id: "minecraft:follow_range", base: 16 },
            ],
            spider: [
                { id: "minecraft:max_health", base: 16 },
                { id: "minecraft:movement_speed", base: 0.3 },
                { id: "minecraft:attack_damage", base: 2 },
                { id: "minecraft:follow_range", base: 16 },
                { id: "minecraft:armor", base: 0 },
            ],
            enderman: [
                { id: "minecraft:max_health", base: 40 },
                { id: "minecraft:movement_speed", base: 0.3 },
                { id: "minecraft:attack_damage", base: 7 },
                { id: "minecraft:follow_range", base: 64 },
                { id: "minecraft:armor", base: 0 },
            ],
            blaze: [
                { id: "minecraft:max_health", base: 20 },
                { id: "minecraft:movement_speed", base: 0.23 },
                { id: "minecraft:attack_damage", base: 6 },
                { id: "minecraft:follow_range", base: 48 },
            ],
            witch: [
                { id: "minecraft:max_health", base: 26 },
                { id: "minecraft:movement_speed", base: 0.25 },
                { id: "minecraft:follow_range", base: 16 },
            ],
            villager: [
                { id: "minecraft:max_health", base: 20 },
                { id: "minecraft:movement_speed", base: 0.5 },
                { id: "minecraft:follow_range", base: 48 },
            ],
            iron_golem: [
                { id: "minecraft:max_health", base: 100 },
                { id: "minecraft:movement_speed", base: 0.25 },
                { id: "minecraft:attack_damage", base: 15 },
                { id: "minecraft:knockback_resistance", base: 1 },
            ],
            wolf: [
                { id: "minecraft:max_health", base: 8 },
                { id: "minecraft:movement_speed", base: 0.3 },
                { id: "minecraft:attack_damage", base: 4 },
                { id: "minecraft:follow_range", base: 16 },
                { id: "minecraft:armor", base: 0 },
            ],
        };

        const key = normalId.split("/").pop()!;
        if (KNOWN_DEFAULTS[key]) {
            return { version: v, entity: `minecraft:${normalId}`, source: "built-in defaults", attributes: KNOWN_DEFAULTS[key] };
        }

        return {
            version: v,
            entity: `minecraft:${normalId}`,
            note: "No attribute data file found for this entity. For modded entities pass the modId parameter and ensure the mod is decompiled.",
            tip: "Use get_mc_class_members on the entity class to see createAttributes() declarations.",
            attributes: [],
        };
    }

    // List all vanilla attribute files
    try {
        const entries = await listMcmetaDir(v, "data", basePath);
        const attrs = entries
            .filter(e => e.type === "file" && e.name.endsWith(".json"))
            .map(e => `minecraft:${e.name.replace(".json", "")}`);
        return { version: v, source: "mcmeta data pack", count: attrs.length, attributes: attrs };
    } catch {
        return {
            version: v,
            note: "Attribute data folder not present in this version. Use get_mc_class_members on net/minecraft/world/entity/ai/attributes/Attributes to see all registered attributes.",
            knownEntities: Object.keys({ player: 1, zombie: 1, skeleton: 1, creeper: 1, spider: 1, enderman: 1, blaze: 1, witch: 1, villager: 1, iron_golem: 1, wolf: 1 }),
        };
    }
}
