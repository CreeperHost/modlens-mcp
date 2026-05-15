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

    const matchingTags: Array<{ tag: string; values: unknown[] }> = [];
    for (const tagId of tagIds) {
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
                matchingTags.push({ tag: `#${namespace}:${tagId}`, values });
            }
        } catch { /* skip broken tags */ }
    }

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

        // Load each recipe to apply filters
        type RecipeJson = { type?: string; result?: unknown; output?: unknown };
        const results: Array<{ id: string; recipeType: string; result: unknown }> = [];
        for (const id of ids) {
            try {
                const data = await fetchMcmetaJson<RecipeJson>(
                    versionRef(v, "data"),
                    `data/minecraft/recipe/${id}.json`,
                );
                const rType = (data.type ?? "").replace("minecraft:", "");
                if (type && !rType.includes(type)) continue;
                if (outputItem) {
                    const resultStr = JSON.stringify(data.result ?? data.output ?? "");
                    if (!resultStr.includes(outputItem.replace("minecraft:", ""))) continue;
                }
                results.push({ id, recipeType: rType, result: data.result ?? data.output });
            } catch { /* skip */ }
        }
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
