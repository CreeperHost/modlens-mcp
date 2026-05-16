/**
 * Tools for reading data/asset files directly from mod JARs.
 *
 * Provides feature parity with the vanilla data tools (recipes, loot tables,
 * advancements, blockstates, models, biomes, sounds, lang, structures) but
 * for any mod in the DB.
 *
 * All functions resolve the mod's JAR path from the DB then use
 * extractEntry / listEntries from jar.ts to read the ZIP/JAR contents.
 * No decompilation is required.
 */

import { db } from "../db.js";
import { extractEntry, listEntries } from "../jar.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

async function resolveMod(modId: string | number) {
    if (typeof modId === "number") {
        return db().mod.findUnique({ where: { id: modId } });
    }
    const numeric = parseInt(modId, 10);
    if (!isNaN(numeric)) {
        const byNum = await db().mod.findUnique({ where: { id: numeric } });
        if (byNum) return byNum;
    }
    return db().mod.findFirst({ where: { modId: { contains: modId } } });
}

/**
 * Detect all namespaces present under a prefix (data/ or assets/) in a JAR.
 * E.g. data/mymod/ → "mymod", data/minecraft/ → "minecraft"
 */
function detectNamespaces(jarPath: string, prefix: "data" | "assets"): string[] {
    const entries = listEntries(jarPath, `${prefix}/`);
    const ns = new Set<string>();
    for (const e of entries) {
        const parts = e.split("/");
        if (parts.length >= 2 && parts[1]) ns.add(parts[1]);
    }
    return [...ns].filter(n => n !== "META-INF" && !n.includes("."));
}

function readJson<T>(jarPath: string, entryPath: string): T | null {
    const buf = extractEntry(jarPath, entryPath);
    if (!buf) return null;
    try { return JSON.parse(buf.toString("utf8")) as T; } catch { return null; }
}

function listJsonEntries(jarPath: string, prefix: string): string[] {
    return listEntries(jarPath, prefix).filter(e => e.endsWith(".json") && !e.endsWith("/"));
}

// ── Generic JAR file access ───────────────────────────────────────────────────

/**
 * List all files inside a mod JAR under an optional path prefix.
 * prefix: e.g. "data/mymod/recipe/", "assets/mymod/blockstates/"
 */
export async function listModJarFiles(modId: string | number, prefix = ""): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const entries = listEntries(mod.jarPath, prefix)
        .filter(e => !e.endsWith("/"))
        .sort();

    return { mod: mod.modId, prefix: prefix || "(root)", count: entries.length, entries };
}

/**
 * Read any file from a mod JAR by its internal path.
 * Returns parsed JSON for .json files, raw text for others.
 * path: e.g. "data/mymod/recipe/iron_sword.json", "assets/mymod/sounds.json"
 */
export async function getModJarFile(modId: string | number, path: string): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const buf = extractEntry(mod.jarPath, path);
    if (!buf) return { mod: mod.modId, path, found: false };

    if (path.endsWith(".json")) {
        try {
            const data = JSON.parse(buf.toString("utf8"));
            return { mod: mod.modId, path, data };
        } catch {
            return { mod: mod.modId, path, raw: buf.toString("utf8") };
        }
    }
    return { mod: mod.modId, path, raw: buf.toString("utf8").slice(0, 4096) };
}

// ── Recipes ───────────────────────────────────────────────────────────────────

export async function listModRecipes(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    const prefix = `data/${ns}/recipe/`;
    let entries = listJsonEntries(mod.jarPath, prefix);

    // Also check "recipes" (plural) used by some mods/older versions
    if (entries.length === 0) {
        entries = listJsonEntries(mod.jarPath, `data/${ns}/recipes/`);
    }

    // Auto-discover if explicit ns yields nothing
    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const n of allNs) {
            const a = listJsonEntries(mod.jarPath, `data/${n}/recipe/`);
            const b = listJsonEntries(mod.jarPath, `data/${n}/recipes/`);
            entries.push(...a, ...b);
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        // data/ns/recipe/id.json → ns:id
        const m = e.match(/^data\/([^/]+)\/recipes?\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, recipes: ids };
}

export async function getModRecipe(
    modId: string | number,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    for (const folder of ["recipe", "recipes"]) {
        const data = readJson(mod.jarPath, `data/${ns}/${folder}/${path}.json`);
        if (data) return { mod: mod.modId, recipe: `${ns}:${path}`, data };
    }
    return { mod: mod.modId, recipe: id, found: false };
}

// ── Loot tables ───────────────────────────────────────────────────────────────

export async function listModLootTables(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `data/${ns}/loot_tables/`);
    if (entries.length === 0) entries = listJsonEntries(mod.jarPath, `data/${ns}/loot_table/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const n of allNs) {
            entries.push(
                ...listJsonEntries(mod.jarPath, `data/${n}/loot_tables/`),
                ...listJsonEntries(mod.jarPath, `data/${n}/loot_table/`),
            );
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^data\/([^/]+)\/loot_tables?\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, lootTables: ids };
}

export async function getModLootTable(
    modId: string | number,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    for (const folder of ["loot_tables", "loot_table"]) {
        const data = readJson(mod.jarPath, `data/${ns}/${folder}/${path}.json`);
        if (data) return { mod: mod.modId, lootTable: `${ns}:${path}`, data };
    }
    return { mod: mod.modId, lootTable: id, found: false };
}

// ── Advancements ──────────────────────────────────────────────────────────────

export async function listModAdvancements(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `data/${ns}/advancement/`);
    if (entries.length === 0) entries = listJsonEntries(mod.jarPath, `data/${ns}/advancements/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const n of allNs) {
            entries.push(
                ...listJsonEntries(mod.jarPath, `data/${n}/advancement/`),
                ...listJsonEntries(mod.jarPath, `data/${n}/advancements/`),
            );
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^data\/([^/]+)\/advancements?\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, advancements: ids };
}

export async function getModAdvancement(
    modId: string | number,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    for (const folder of ["advancement", "advancements"]) {
        const data = readJson(mod.jarPath, `data/${ns}/${folder}/${path}.json`);
        if (data) return { mod: mod.modId, advancement: `${ns}:${path}`, data };
    }
    return { mod: mod.modId, advancement: id, found: false };
}

// ── Blockstates ───────────────────────────────────────────────────────────────

export async function getModBlockstate(
    modId: string | number,
    block: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (block.includes(":") ? block.split(":")[0] : mod.modId);
    const name = block.includes(":") ? block.split(":")[1] : block.replace(".json", "");

    const data = readJson(mod.jarPath, `assets/${ns}/blockstates/${name}.json`);
    if (data) return { mod: mod.modId, block: `${ns}:${name}`, data };
    return { mod: mod.modId, block, found: false };
}

export async function listModBlockstates(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `assets/${ns}/blockstates/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "assets");
        for (const n of allNs.filter(n => n !== "minecraft")) {
            entries.push(...listJsonEntries(mod.jarPath, `assets/${n}/blockstates/`));
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^assets\/([^/]+)\/blockstates\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, blockstates: ids };
}

// ── Models ────────────────────────────────────────────────────────────────────

export async function getModModel(
    modId: string | number,
    modelPath: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (modelPath.includes(":") ? modelPath.split(":")[0] : mod.modId);
    const path = modelPath.includes(":") ? modelPath.split(":")[1] : modelPath;
    const fullPath = path.includes("/") ? path : `item/${path}`;

    const data = readJson(mod.jarPath, `assets/${ns}/models/${fullPath}.json`);
    if (data) return { mod: mod.modId, model: `${ns}:${fullPath}`, data };
    return { mod: mod.modId, model: modelPath, found: false };
}

export async function listModModels(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `assets/${ns}/models/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "assets");
        for (const n of allNs.filter(n => n !== "minecraft")) {
            entries.push(...listJsonEntries(mod.jarPath, `assets/${n}/models/`));
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^assets\/([^/]+)\/models\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, models: ids };
}

// ── Biomes ────────────────────────────────────────────────────────────────────

export async function listModBiomes(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `data/${ns}/worldgen/biome/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const n of allNs) {
            entries.push(...listJsonEntries(mod.jarPath, `data/${n}/worldgen/biome/`));
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^data\/([^/]+)\/worldgen\/biome\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, biomes: ids };
}

export async function getModBiome(
    modId: string | number,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    const data = readJson(mod.jarPath, `data/${ns}/worldgen/biome/${path}.json`);
    if (data) return { mod: mod.modId, biome: `${ns}:${path}`, data };
    return { mod: mod.modId, biome: id, found: false };
}

// ── Worldgen structures ───────────────────────────────────────────────────────

export async function listModStructures(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `data/${ns}/worldgen/structure/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const n of allNs) {
            entries.push(...listJsonEntries(mod.jarPath, `data/${n}/worldgen/structure/`));
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^data\/([^/]+)\/worldgen\/structure\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, structures: ids };
}

export async function getModStructureData(
    modId: string | number,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    const data = readJson(mod.jarPath, `data/${ns}/worldgen/structure/${path}.json`);
    if (data) return { mod: mod.modId, structure: `${ns}:${path}`, data };
    return { mod: mod.modId, structure: id, found: false };
}

// ── Lang ──────────────────────────────────────────────────────────────────────

export async function getModLang(
    modId: string | number,
    filter?: string,
    limit = 200,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    // Try all namespaces
    const allNs = detectNamespaces(mod.jarPath, "assets");
    let lang: Record<string, string> | null = null;
    let usedNs = "";

    for (const ns of allNs) {
        for (const name of ["en_us.json", "en_US.json"]) {
            const buf = extractEntry(mod.jarPath, `assets/${ns}/lang/${name}`);
            if (buf) {
                try {
                    lang = JSON.parse(buf.toString("utf8"));
                    usedNs = ns;
                    break;
                } catch { /* skip */ }
            }
        }
        if (lang) break;
    }

    if (!lang) return { mod: mod.modId, found: false, note: "No en_us.json lang file found." };

    let entries = Object.entries(lang);
    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(([k, v]) => k.toLowerCase().includes(f) || v.toLowerCase().includes(f));
    }

    return {
        mod: mod.modId,
        namespace: usedNs,
        total: Object.keys(lang).length,
        shown: Math.min(entries.length, limit),
        filter: filter ?? "(none)",
        entries: Object.fromEntries(entries.slice(0, limit)),
    };
}

// ── Sounds ────────────────────────────────────────────────────────────────────

export async function getModSounds(
    modId: string | number,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let data = readJson(mod.jarPath, `assets/${ns}/sounds.json`);

    if (!data) {
        const allNs = detectNamespaces(mod.jarPath, "assets");
        for (const n of allNs.filter(n => n !== "minecraft")) {
            data = readJson(mod.jarPath, `assets/${n}/sounds.json`);
            if (data) { break; }
        }
    }

    if (!data) return { mod: mod.modId, found: false };
    return { mod: mod.modId, data };
}

// ── Tags (data pack) ──────────────────────────────────────────────────────────

export async function listModDataTags(
    modId: string | number,
    registry?: string,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    const regPath = registry ? `data/${ns}/tags/${registry}/` : `data/${ns}/tags/`;
    let entries = listJsonEntries(mod.jarPath, regPath);

    if (entries.length === 0 && !namespace) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const n of allNs) {
            const base = registry ? `data/${n}/tags/${registry}/` : `data/${n}/tags/`;
            entries.push(...listJsonEntries(mod.jarPath, base));
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^data\/([^/]+)\/tags\/([^/]+)\/(.*?)\.json$/);
        return m ? { registry: m[2], tag: `${m[1]}:${m[3]}`, path: e } : { registry: "unknown", tag: e, path: e };
    });

    return { mod: mod.modId, count: ids.length, tags: ids };
}

export async function getModDataTag(
    modId: string | number,
    registry: string,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    const data = readJson(mod.jarPath, `data/${ns}/tags/${registry}/${path}.json`);
    if (data) return { mod: mod.modId, registry, tag: `${ns}:${path}`, data };
    return { mod: mod.modId, registry, tag: id, found: false };
}

// ── Particles ─────────────────────────────────────────────────────────────────

export async function listModParticles(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `assets/${ns}/particles/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "assets");
        for (const n of allNs.filter(n => n !== "minecraft")) {
            entries.push(...listJsonEntries(mod.jarPath, `assets/${n}/particles/`));
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^assets\/([^/]+)\/particles\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, particles: ids };
}

export async function getModParticle(
    modId: string | number,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    const data = readJson(mod.jarPath, `assets/${ns}/particles/${path}.json`);
    if (data) return { mod: mod.modId, particle: `${ns}:${path}`, data };
    return { mod: mod.modId, particle: id, found: false };
}

// ── Damage types ──────────────────────────────────────────────────────────────

export async function listModDamageTypes(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `data/${ns}/damage_type/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const n of allNs) {
            entries.push(...listJsonEntries(mod.jarPath, `data/${n}/damage_type/`));
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^data\/([^/]+)\/damage_type\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    return { mod: mod.modId, count: ids.length, damageTypes: ids };
}

export async function getModDamageType(
    modId: string | number,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    const data = readJson(mod.jarPath, `data/${ns}/damage_type/${path}.json`);
    if (data) return { mod: mod.modId, damageType: `${ns}:${path}`, data };
    return { mod: mod.modId, damageType: id, found: false };
}

// ── Atlas ─────────────────────────────────────────────────────────────────────

export async function getModAtlas(
    modId: string | number,
    atlas = "blocks",
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    const name = atlas.replace(".json", "");

    let data = readJson(mod.jarPath, `assets/${ns}/atlases/${name}.json`);
    if (!data && !namespace) {
        const allNs = detectNamespaces(mod.jarPath, "assets");
        for (const n of allNs.filter(n => n !== "minecraft")) {
            data = readJson(mod.jarPath, `assets/${n}/atlases/${name}.json`);
            if (data) break;
        }
    }

    if (data) return { mod: mod.modId, atlas: name, data };
    return { mod: mod.modId, atlas: name, found: false };
}

// ── Enchantments (data-pack files, 1.21+) ────────────────────────────────────

export async function listModEnchantments(
    modId: string | number,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? mod.modId;
    let entries = listJsonEntries(mod.jarPath, `data/${ns}/enchantment/`);

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const n of allNs) {
            entries.push(...listJsonEntries(mod.jarPath, `data/${n}/enchantment/`));
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        const m = e.match(/^data\/([^/]+)\/enchantment\/(.*?)\.json$/);
        return m ? `${m[1]}:${m[2]}` : e;
    });

    if (ids.length === 0) {
        return {
            mod: mod.modId,
            count: 0,
            note: "No enchantment data files found. Older mods register enchantments in code — use list_mod_registry_entries with type='enchantment' to list them from the lang file instead.",
            enchantments: [],
        };
    }

    return { mod: mod.modId, count: ids.length, enchantments: ids };
}

export async function getModEnchantment(
    modId: string | number,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    const data = readJson(mod.jarPath, `data/${ns}/enchantment/${path}.json`);
    if (data) return { mod: mod.modId, enchantment: `${ns}:${path}`, data };
    return {
        mod: mod.modId,
        enchantment: id,
        found: false,
        note: "Not present as a data file. Use list_mod_registry_entries with type='enchantment' to list enchantments from the lang file.",
    };
}

// ── Generic data-path helpers (worldgen, dimension, variants, etc.) ───────────

/**
 * Maps mod_data type names → list of candidate subdirectory paths under data/<ns>/.
 * Some types have alternate folder names for compatibility across MC versions.
 */
export const GENERIC_DATA_DIRS: Record<string, string[]> = {
    configured_feature:  ["worldgen/configured_feature"],
    placed_feature:      ["worldgen/placed_feature"],
    structure_set:       ["worldgen/structure_set"],
    noise:               ["worldgen/noise"],
    density_function:    ["worldgen/density_function"],
    processor_list:      ["worldgen/processor_list"],
    template_pool:       ["worldgen/template_pool"],
    dimension_type:      ["dimension_type"],
    dimension:           ["dimension"],
    trim_material:       ["trim_material"],
    trim_pattern:        ["trim_pattern"],
    painting_variant:    ["painting_variant"],
    wolf_variant:        ["wolf_variant"],
    cat_variant:         ["cat_variant"],
    chat_type:           ["chat_type"],
};

export async function listModGenericDataType(
    modId: string | number,
    typeKey: string,
    namespace?: string,
    filter?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const dirs = GENERIC_DATA_DIRS[typeKey];
    if (!dirs) return { error: `Unknown data type: ${typeKey}` };

    let entries: string[] = [];

    if (namespace) {
        for (const dir of dirs) {
            entries.push(...listJsonEntries(mod.jarPath, `data/${namespace}/${dir}/`));
        }
    }

    if (entries.length === 0) {
        const allNs = detectNamespaces(mod.jarPath, "data");
        for (const ns of allNs) {
            for (const dir of dirs) {
                entries.push(...listJsonEntries(mod.jarPath, `data/${ns}/${dir}/`));
            }
        }
    }

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(f));
    }

    const ids = entries.map(e => {
        // data/<ns>/<dir>/[sub/]name.json → ns:dir/[sub/]name
        const m = e.match(/^data\/([^/]+)\/(.+?)\.json$/);
        if (!m) return e;
        // Strip the type dir prefix to get just the resource path
        const fullPath = m[2]; // e.g. worldgen/configured_feature/my_feature
        // Find which dir prefix applies
        for (const dir of dirs) {
            if (fullPath.startsWith(dir + "/")) {
                return `${m[1]}:${fullPath.slice(dir.length + 1)}`;
            }
        }
        return `${m[1]}:${fullPath}`;
    });

    return { mod: mod.modId, type: typeKey, count: ids.length, entries: ids };
}

export async function getModGenericDataType(
    modId: string | number,
    typeKey: string,
    id: string,
    namespace?: string,
): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const dirs = GENERIC_DATA_DIRS[typeKey];
    if (!dirs) return { error: `Unknown data type: ${typeKey}` };

    const ns = namespace ?? (id.includes(":") ? id.split(":")[0] : mod.modId);
    const path = id.includes(":") ? id.split(":")[1] : id;

    for (const dir of dirs) {
        const data = readJson(mod.jarPath, `data/${ns}/${dir}/${path}.json`);
        if (data) return { mod: mod.modId, type: typeKey, id: `${ns}:${path}`, data };
    }

    return { mod: mod.modId, type: typeKey, id, found: false };
}

// ── Mod manifest reader ───────────────────────────────────────────────────────

/**
 * Read and parse the mod's loader manifest file:
 *   NeoForge/Forge → META-INF/neoforge.mods.toml or META-INF/mods.toml
 *   Fabric          → fabric.mod.json
 *   Quilt           → quilt.mod.json
 *
 * Returns raw text (TOML) or parsed JSON depending on format.
 */
export async function getModManifest(modId: string | number): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const candidates: Array<{ path: string; format: "toml" | "json" }> = [
        { path: "META-INF/neoforge.mods.toml", format: "toml" },
        { path: "META-INF/mods.toml",          format: "toml" },
        { path: "fabric.mod.json",              format: "json" },
        { path: "quilt.mod.json",               format: "json" },
    ];

    for (const { path, format } of candidates) {
        const buf = extractEntry(mod.jarPath, path);
        if (!buf) continue;
        const raw = buf.toString("utf8");
        if (format === "json") {
            try {
                return { mod: mod.modId, manifestPath: path, format, data: JSON.parse(raw) };
            } catch {
                return { mod: mod.modId, manifestPath: path, format, raw };
            }
        }
        // TOML — return raw text (TOML parsing requires a dep we don't have)
        return { mod: mod.modId, manifestPath: path, format, raw };
    }

    return { mod: mod.modId, error: "No manifest file found (neoforge.mods.toml, mods.toml, fabric.mod.json, quilt.mod.json)" };
}

// ── Config file browser ───────────────────────────────────────────────────────

/**
 * List default config files shipped inside the JAR under defaultconfigs/ or config/.
 * These are the starter configs a mod ships; they get copied to the instance config dir on first run.
 */
export async function listModConfigs(modId: string | number): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const prefixes = ["defaultconfigs/", "config/"];
    const files: string[] = [];
    for (const prefix of prefixes) {
        files.push(...listEntries(mod.jarPath, prefix).filter(e => !e.endsWith("/")));
    }

    return { mod: mod.modId, count: files.length, configs: files };
}

export async function getModConfig(modId: string | number, path: string): Promise<object> {
    const mod = await resolveMod(modId);
    if (!mod) return { error: `Mod not found: ${modId}` };

    const buf = extractEntry(mod.jarPath, path);
    if (!buf) return { mod: mod.modId, path, found: false };

    const raw = buf.toString("utf8");
    if (path.endsWith(".json")) {
        try { return { mod: mod.modId, path, data: JSON.parse(raw) }; } catch { /* fall through */ }
    }
    return { mod: mod.modId, path, raw: raw.slice(0, 8192) };
}

// ── Data diff between mod versions ────────────────────────────────────────────

/**
 * Compare data files between two mod versions (by DB id).
 * Returns: files only in A (removed), only in B (added), and files in both whose
 * JSON content changed. Use type filter to scope to a specific category.
 */
export async function diffModData(
    dbIdA: number,
    dbIdB: number,
    dataType?: string, // e.g. "recipe", "loot_table" — filters by path substring
): Promise<object> {
    const [modA, modB] = await Promise.all([
        db().mod.findUnique({ where: { id: dbIdA } }),
        db().mod.findUnique({ where: { id: dbIdB } }),
    ]);
    if (!modA) return { error: `Mod #${dbIdA} not found` };
    if (!modB) return { error: `Mod #${dbIdB} not found` };

    const getDataEntries = (jarPath: string): Map<string, string> => {
        let entries = listJsonEntries(jarPath, "data/");
        if (dataType) {
            const f = dataType.toLowerCase();
            entries = entries.filter(e => e.toLowerCase().includes(f));
        }
        const map = new Map<string, string>();
        for (const e of entries) {
            const buf = extractEntry(jarPath, e);
            map.set(e, buf ? buf.toString("utf8") : "");
        }
        return map;
    };

    const [filesA, filesB] = await Promise.all([
        Promise.resolve(getDataEntries(modA.jarPath)),
        Promise.resolve(getDataEntries(modB.jarPath)),
    ]);

    const keysA = new Set(filesA.keys());
    const keysB = new Set(filesB.keys());

    const added   = [...keysB].filter(k => !keysA.has(k));
    const removed = [...keysA].filter(k => !keysB.has(k));
    const changed: Array<{ path: string; note: string }> = [];

    for (const k of keysA) {
        if (!keysB.has(k)) continue;
        const contentA = filesA.get(k)!.trim();
        const contentB = filesB.get(k)!.trim();
        if (contentA !== contentB) {
            // Try to summarise the change at JSON key level
            let note = "content changed";
            try {
                const a = JSON.parse(contentA);
                const b = JSON.parse(contentB);
                const changedKeys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
                    .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
                if (changedKeys.length > 0) note = `changed keys: ${changedKeys.join(", ")}`;
            } catch { /* not JSON or nested — keep note as-is */ }
            changed.push({ path: k, note });
        }
    }

    return {
        modA: { id: dbIdA, modId: modA.modId, version: modA.version },
        modB: { id: dbIdB, modId: modB.modId, version: modB.version },
        dataType: dataType ?? "(all)",
        summary: { added: added.length, removed: removed.length, changed: changed.length },
        added,
        removed,
        changed,
    };
}

// ── Recipe chain tracer ────────────────────────────────────────────────────────

interface RecipeJson {
    type?: string;
    result?: { id?: string; item?: string; count?: number } | string;
    ingredients?: Array<{ item?: string; tag?: string } | string>;
    ingredient?: { item?: string; tag?: string } | string;
    base?: { item?: string; tag?: string } | string;
    addition?: { item?: string; tag?: string } | string;
    input?: { item?: string; tag?: string } | string;
    key?: Record<string, { item?: string; tag?: string } | string>;
}

function extractIngredients(recipe: RecipeJson): string[] {
    const items: string[] = [];
    const push = (v: unknown) => {
        if (!v) return;
        if (typeof v === "string") { items.push(v); return; }
        if (typeof v === "object" && v !== null) {
            const o = v as { item?: string; tag?: string };
            if (o.item) items.push(o.item);
            else if (o.tag) items.push(`#${o.tag}`);
        }
    };

    // shaped/shapeless via ingredients array or key map
    if (Array.isArray(recipe.ingredients)) recipe.ingredients.forEach(push);
    if (recipe.ingredient) push(recipe.ingredient);
    if (recipe.base)       push(recipe.base);
    if (recipe.addition)   push(recipe.addition);
    if (recipe.input)      push(recipe.input);
    if (recipe.key) Object.values(recipe.key).forEach(push);
    return items;
}

function extractResult(recipe: RecipeJson): string | null {
    if (!recipe.result) return null;
    if (typeof recipe.result === "string") return recipe.result;
    return recipe.result.id ?? recipe.result.item ?? null;
}

/**
 * Trace the full crafting dependency tree for an item.
 * Recursively resolves all recipes that produce it across all mods in the DB,
 * and for each ingredient finds its recipes too.
 *
 * itemId: resource id of the target item, e.g. "mekanism:steel_ingot"
 * maxDepth: recursion guard (default 6)
 * Returns a tree structure with recipes and their ingredients' sub-trees.
 */
export async function traceRecipeChain(
    itemId: string,
    maxDepth = 6,
): Promise<object> {
    // Build a recipe index: resultId → [{modId, recipeId, type, ingredients, raw}]
    const allMods = await db().mod.findMany({ select: { id: true, modId: true, version: true, jarPath: true } });

    // Index all recipes from all mods (lazy — cache by modId)
    const recipeIndex = new Map<string, Array<{ mod: string; recipeId: string; type: string; ingredients: string[]; resultCount: number }>>();

    for (const mod of allMods) {
        const entries = listEntries(mod.jarPath, "data/").filter(e => e.includes("/recipes/") && e.endsWith(".json"));
        for (const entry of entries) {
            const buf = extractEntry(mod.jarPath, entry);
            if (!buf) continue;
            try {
                const recipe = JSON.parse(buf.toString("utf8")) as RecipeJson;
                const result = extractResult(recipe);
                if (!result) continue;
                const normalId = result.includes(":") ? result : `minecraft:${result}`;
                if (!recipeIndex.has(normalId)) recipeIndex.set(normalId, []);
                recipeIndex.get(normalId)!.push({
                    mod:         mod.modId,
                    recipeId:    entry,
                    type:        recipe.type ?? "unknown",
                    ingredients: extractIngredients(recipe),
                    resultCount: typeof recipe.result === "object" && recipe.result !== null
                        ? (recipe.result as { count?: number }).count ?? 1
                        : 1,
                });
            } catch { /* skip malformed */ }
        }
    }

    const visited = new Set<string>();

    const buildTree = (id: string, depth: number): unknown => {
        if (depth > maxDepth || visited.has(id)) {
            return { item: id, note: depth > maxDepth ? "maxDepth reached" : "circular ref skipped", recipes: [] };
        }
        visited.add(id);
        const normal = id.includes(":") ? id : `minecraft:${id}`;
        const recipes = recipeIndex.get(normal) ?? [];

        const recipeNodes = recipes.map(r => ({
            mod:         r.mod,
            recipeId:    r.recipeId,
            type:        r.type,
            resultCount: r.resultCount,
            ingredients: r.ingredients.map(ing => buildTree(ing, depth + 1)),
        }));

        visited.delete(id); // allow same item via different paths at different depths
        return { item: normal, recipeCount: recipes.length, recipes: recipeNodes };
    };

    const tree = buildTree(itemId, 0);
    return {
        target:        itemId,
        maxDepth,
        modsScanned:   allMods.length,
        totalRecipesIndexed: [...recipeIndex.values()].reduce((s, v) => s + v.length, 0),
        tree,
    };
}
