/**
 * KubeJS script analysis tools.
 *
 * Scans a KubeJS scripts directory and indexes what each script does:
 * which events it listens to, what it modifies (recipes, tags, loot, items, etc.)
 *
 * Works on the raw .js / .ts files — no execution required.
 */

import { readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { join, extname } from "path";
import { embed, isOllamaAvailable } from "../embeddings.js";
import { assertHostAccessiblePath } from "../security.js";

// ── Event pattern registry ────────────────────────────────────────────────────

const KUBEJS_PATTERNS: Record<string, string[]> = {
    "recipe_add":        ["event.recipes.", "event.shaped(", "event.shapeless(", "event.smelting(", "event.blasting(", "event.smoking(", "event.campfireCooking(", "event.stonecutting(", "event.smithing("],
    "recipe_remove":     ["event.remove(", "event.replaceInput(", "event.replaceOutput("],
    "recipe_custom":     ["event.custom("],
    "tag_modify":        ["event.add(", "event.remove(", "event.removeAll("],
    "loot_modify":       ["LootJS", "event.modifyLootTables(", "event.addCondition(", "event.addPool("],
    "item_register":     ["event.create(", "ItemEvents.modification", "event.modify("],
    "block_register":    ["BlockEvents", "event.create("],
    "fluid_register":    ["FluidEvents", "event.create("],
    "entity_register":   ["EntityJSEvents", "EntityEvents"],
    "worldgen_modify":   ["WorldgenEvents", "event.addLayer(", "event.removeLayer(", "event.addBiome("],
    "startup_register":  ["StartupEvents.registry", "event.register(", "event.createRecipeSerializer("],
    "client_asset":      ["ClientEvents", "event.painter(", "event.addLayer("],
    "player_events":     ["PlayerEvents", "event.give(", "event.sendMessage("],
    "server_events":     ["ServerEvents.loaded", "ServerEvents.commmandRegistry", "event.addCommand("],
    "forge_events":      ["ForgeEvents", "event.register("],
    "jei_integration":   ["JEIEvents", "JEIPlugin", "event.hideItem(", "event.addItem("],
    "kubejs_additions":  ["KubeJSAdditions", "MoreJSEvents"],
};

// ── File walker ───────────────────────────────────────────────────────────────

function walkDir(dir: string, exts: string[] = [".js", ".ts"]): string[] {
    assertHostAccessiblePath(dir);
    const files: string[] = [];
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...walkDir(full, exts));
            } else if (exts.includes(extname(entry.name).toLowerCase())) {
                files.push(full);
            }
        }
    } catch { /* skip unreadable dirs */ }
    return files;
}

// ── Script scanner ────────────────────────────────────────────────────────────

interface ScriptAnalysis {
    path:        string;
    lineCount:   number;
    byteSize:    number;
    categories:  string[];
    snippets:    Record<string, string[]>;  // category → matching lines (capped at 5 each)
}

function analyzeScript(relativePath: string, content: string): ScriptAnalysis {
    const lines      = content.split("\n");
    const categories: string[] = [];
    const snippets:   Record<string, string[]> = {};

    for (const [category, triggers] of Object.entries(KUBEJS_PATTERNS)) {
        const matches: string[] = [];
        for (const line of lines) {
            const t = line.trim();
            if (t.startsWith("//") || t.startsWith("*")) continue; // skip comments
            if (triggers.some(trigger => t.includes(trigger))) {
                matches.push(t.slice(0, 120));
            }
        }
        if (matches.length > 0) {
            categories.push(category);
            snippets[category] = [...new Set(matches)].slice(0, 5); // dedupe + cap
        }
    }

    return {
        path:       relativePath,
        lineCount:  lines.length,
        byteSize:   content.length,
        categories,
        snippets,
    };
}

// ── Public tools ──────────────────────────────────────────────────────────────

/**
 * Index all KubeJS scripts under a directory.
 * Returns a per-file breakdown of which event categories each script touches,
 * plus an overall summary of what the pack's scripts do.
 *
 * scriptsDir: absolute path to the kubejs/ folder (or any subfolder like kubejs/server_scripts/)
 */
export async function indexKubeJsScripts(scriptsDir: string): Promise<object> {
    const files = walkDir(scriptsDir);
    if (files.length === 0) {
        return { error: `No .js/.ts files found under: ${scriptsDir}` };
    }

    const scripts: ScriptAnalysis[] = [];
    for (const file of files) {
        try {
            const content = readFileSync(file, "utf8");
            const rel = file.replace(scriptsDir, "").replace(/\\/g, "/").replace(/^\//, "");
            scripts.push(analyzeScript(rel, content));
        } catch { /* skip unreadable */ }
    }

    // Aggregate: how many scripts touch each category
    const categorySummary: Record<string, number> = {};
    for (const s of scripts) {
        for (const cat of s.categories) {
            categorySummary[cat] = (categorySummary[cat] ?? 0) + 1;
        }
    }

    const totalLines     = scripts.reduce((s, f) => s + f.lineCount, 0);
    const active         = scripts.filter(s => s.categories.length > 0);
    const inert          = scripts.filter(s => s.categories.length === 0).map(s => s.path);

    return {
        scriptsDir,
        fileCount:       scripts.length,
        activeScripts:   active.length,
        totalLines,
        categorySummary,
        scripts:         active,
        inertScripts:    inert,
    };
}

/**
 * Search all KubeJS scripts under a directory for a text pattern.
 * Returns matching lines with file + line number context.
 *
 * scriptsDir: absolute path to the kubejs/ folder
 * query: substring to search for (case-insensitive)
 * limit: max results (default 60)
 */
export async function searchKubeJsScripts(
    scriptsDir: string,
    query: string,
    limit = 60,
): Promise<object> {
    const files     = walkDir(scriptsDir);
    const lower     = query.toLowerCase();
    const results: Array<{ file: string; line: number; content: string }> = [];

    outer:
    for (const file of files) {
        try {
            const lines = readFileSync(file, "utf8").split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(lower)) {
                    results.push({
                        file:    file.replace(scriptsDir, "").replace(/\\/g, "/").replace(/^\//, ""),
                        line:    i + 1,
                        content: lines[i].trim().slice(0, 200),
                    });
                    if (results.length >= limit) break outer;
                }
            }
        } catch { /* skip */ }
    }

    return {
        scriptsDir,
        query,
        totalMatches: results.length,
        capped:       results.length >= limit,
        results,
    };
}

// ── Embedding cache (survives across MCP tool calls in the same server session) ──

const EMBED_CACHE_MAX = 500;
const embedCache = new Map<string, number[]>();

function contentHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

async function cachedEmbed(text: string): Promise<number[] | null> {
    const hash = contentHash(text);
    const cached = embedCache.get(hash);
    if (cached) return cached;
    const vec = await embed(text);
    if (vec) {
        if (embedCache.size >= EMBED_CACHE_MAX) {
            // Evict oldest entry (first inserted)
            const oldest = embedCache.keys().next().value;
            if (oldest !== undefined) embedCache.delete(oldest);
        }
        embedCache.set(hash, vec);
    }
    return vec;
}

// ── Cosine similarity helper ──────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Semantic search over KubeJS scripts using Ollama embeddings.
 *
 * Reads all scripts from disk, embeds each file's content and the query,
 * then ranks by cosine similarity. Requires Ollama running.
 *
 * scriptsDir: absolute path to the kubejs/ folder
 * query: natural language question
 * limit: max results (default 10)
 */
export async function semanticSearchKubeJsScripts(
    scriptsDir: string,
    query: string,
    limit = 10,
): Promise<object> {
    if (!await isOllamaAvailable()) {
        return { error: "Ollama is not available. Start Ollama to use semantic search." };
    }

    const files = walkDir(scriptsDir);
    if (files.length === 0) {
        return { error: `No .js/.ts files found under: ${scriptsDir}` };
    }

    // Embed the query (not cached — queries vary)
    const queryVec = await embed(query);
    if (!queryVec) {
        return { error: "Failed to generate embedding for query." };
    }

    // Read and embed each script (first 4000 chars, cached by content hash)
    const scored: Array<{ file: string; score: number; preview: string; lineCount: number; categories: string[] }> = [];

    for (const file of files) {
        try {
            const content = readFileSync(file, "utf8");
            const rel = file.replace(scriptsDir, "").replace(/\\/g, "/").replace(/^\//, "");
            const snippet = content.slice(0, 4000);
            const vec = await cachedEmbed(snippet);
            if (!vec) continue;

            const score = cosine(queryVec, vec);
            const analysis = analyzeScript(rel, content);
            scored.push({
                file: rel,
                score: Math.round(score * 10000) / 10000,
                preview: content.split("\n").slice(0, 5).join("\n").trim().slice(0, 300),
                lineCount: analysis.lineCount,
                categories: analysis.categories,
            });
        } catch { /* skip unreadable */ }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    return {
        scriptsDir,
        query,
        model: "nomic-embed-text",
        totalFiles: files.length,
        results: top,
    };
}
