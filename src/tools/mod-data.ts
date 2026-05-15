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
