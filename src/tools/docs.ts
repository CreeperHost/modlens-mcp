/**
 * MCP tools for documentation management.
 *
 * All docs are stored in PostgreSQL (doc_entries table) — nothing is hardcoded.
 * On first use call seed_default_documentation to populate the known defaults
 * (Fabric/NeoForge wiki links and the classic minecraft-dev-mcp class map).
 *
 * Tools:
 *   ingest_documentation     - Add one or many doc entries (URL + metadata)
 *   get_documentation        - Look up docs by class name or keyword
 *   search_documentation     - Full-text search across title/summary/className
 *   list_documentation       - List entries filtered by category/namespace/tag
 *   delete_documentation     - Remove an entry by ID
 *   seed_default_documentation - Populate the default Fabric/NeoForge/MC entries
 */
import { db } from "../db.js";
import type { Prisma } from "@prisma/client";
import { embed, isOllamaAvailable } from "../embeddings.js";
import { upsertDocEmbedding, searchDocsByVector, countUnembedded } from "../repositories/embeddings.js";

export interface DocEntryInput {
    className?: string;
    title: string;
    summary?: string;
    url: string;
    category?: string;   // minecraft | neoforge | fabric | forge | quilt | mod | other
    namespace?: string;  // vanilla | neoforge | fabric | forge | quilt | parchment
    tags?: string[];
    source?: string;     // manual | seed | parchment | javadoc
}

// ── ingest_documentation ──────────────────────────────────────────────────────
export async function ingestDocumentation(entries: DocEntryInput[]): Promise<object> {
    const results = [];
    for (const e of entries) {
        const existing = e.className
            ? await db().docEntry.findFirst({ where: { className: e.className, url: e.url } })
            : await db().docEntry.findFirst({ where: { title: e.title, url: e.url } });

        if (existing) {
            const updated = await db().docEntry.update({
                where: { id: existing.id },
                data: {
                    title: e.title,
                    summary: e.summary,
                    category: e.category ?? existing.category,
                    namespace: e.namespace ?? existing.namespace,
                    tags: e.tags ?? existing.tags,
                    source: e.source ?? existing.source,
                },
            });
            results.push({ action: "updated", id: updated.id, title: updated.title });
            await tryEmbedDoc(updated.id, updated.title, updated.summary);
        } else {
            const created = await db().docEntry.create({
                data: {
                    className: e.className ?? null,
                    title: e.title,
                    summary: e.summary ?? null,
                    url: e.url,
                    category: e.category ?? "minecraft",
                    namespace: e.namespace ?? "vanilla",
                    tags: e.tags ?? [],
                    source: e.source ?? "manual",
                },
            });
            results.push({ action: "created", id: created.id, title: created.title });
            await tryEmbedDoc(created.id, created.title, created.summary);
        }
    }
    return { ingested: results.length, results };
}

// ── get_documentation ─────────────────────────────────────────────────────────
export async function getDocumentation(query: string): Promise<object> {
    // Try exact class name match first
    const normalized = query.replace(/\./g, "/");
    const byClass = await db().docEntry.findMany({
        where: {
            OR: [
                { className: query },
                { className: normalized },
                { className: query.replace(/\//g, ".") },
            ],
        },
        orderBy: { createdAt: "asc" },
    });
    if (byClass.length > 0) return { found: true, query, results: byClass };

    // Fall back to title/summary keyword search (case-insensitive)
    const keyword = query.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
    const rows = await db().$queryRaw<Array<{
        id: number; class_name: string | null; title: string; summary: string | null;
        url: string; category: string; namespace: string; tags: string[];
    }>>`
        SELECT id, class_name, title, summary, url, category, namespace, tags
        FROM doc_entries
        WHERE lower(title) LIKE ${"%" + keyword + "%"}
           OR lower(summary) LIKE ${"%" + keyword + "%"}
           OR lower(class_name) LIKE ${"%" + keyword + "%"}
        ORDER BY id
        LIMIT 20
    `;
    return { found: rows.length > 0, query, results: rows };
}

// ── search_documentation ──────────────────────────────────────────────────────
export async function searchDocumentation(query: string, category?: string, namespace?: string): Promise<object> {
    const kw = query.toLowerCase();

    const where: Prisma.DocEntryWhereInput = {
        OR: [
            { title:    { contains: kw, mode: "insensitive" } },
            { summary:  { contains: kw, mode: "insensitive" } },
            { className:{ contains: kw, mode: "insensitive" } },
        ],
    };
    if (category)  where.category  = category;
    if (namespace) where.namespace = namespace;

    const results = await db().docEntry.findMany({
        where,
        orderBy: { title: "asc" },
        take: 50,
    });
    return { query, count: results.length, results };
}

// ── list_documentation ────────────────────────────────────────────────────────
export async function listDocumentation(
    category?: string,
    namespace?: string,
    tag?: string,
    limit = 100,
): Promise<object> {
    const where: Record<string, unknown> = {};
    if (category)  where.category  = category;
    if (namespace) where.namespace = namespace;
    if (tag)       where.tags      = { has: tag };

    const total = await db().docEntry.count({ where });
    const results = await db().docEntry.findMany({
        where,
        orderBy: [{ category: "asc" }, { title: "asc" }],
        take: limit,
    });
    return { total, returned: results.length, results };
}

// ── delete_documentation ──────────────────────────────────────────────────────
export async function deleteDocumentation(id: number): Promise<object> {
    const existing = await db().docEntry.findUnique({ where: { id } });
    if (!existing) return { deleted: false, message: `No doc entry with id ${id}` };
    await db().docEntry.delete({ where: { id } });
    return { deleted: true, id, title: existing.title };
}

// ── seed_default_documentation ────────────────────────────────────────────────
const DEFAULT_DOCS: DocEntryInput[] = [
    // ── Fabric/Vanilla class mappings (from minecraft-dev-mcp KNOWN_DOCS) ──
    { className: "net.minecraft.entity.Entity",               title: "Entity",              summary: "Base class for all entities in Minecraft",                                url: "https://fabricmc.net/wiki/tutorial:entity",         category: "minecraft", namespace: "fabric", tags: ["entity"] },
    { className: "net.minecraft.entity.LivingEntity",         title: "LivingEntity",        summary: "Base class for all living entities (mobs, players)",                    url: "https://fabricmc.net/wiki/tutorial:entity",         category: "minecraft", namespace: "fabric", tags: ["entity"] },
    { className: "net.minecraft.entity.player.PlayerEntity",  title: "PlayerEntity",        summary: "Represents a player in the game world",                                 url: "https://fabricmc.net/wiki/tutorial:entity",         category: "minecraft", namespace: "fabric", tags: ["entity", "player"] },
    { className: "net.minecraft.block.Block",                 title: "Block",               summary: "Base class for all blocks in the world",                                url: "https://fabricmc.net/wiki/tutorial:blocks",         category: "minecraft", namespace: "fabric", tags: ["block"] },
    { className: "net.minecraft.block.BlockState",            title: "BlockState",          summary: "Immutable snapshot of a block with its properties",                     url: "https://fabricmc.net/wiki/tutorial:blockstate",     category: "minecraft", namespace: "fabric", tags: ["block"] },
    { className: "net.minecraft.item.Item",                   title: "Item",                summary: "Base class for all items in the game",                                  url: "https://fabricmc.net/wiki/tutorial:items",          category: "minecraft", namespace: "fabric", tags: ["item"] },
    { className: "net.minecraft.item.ItemStack",              title: "ItemStack",           summary: "Represents a stack of items with count and NBT data",                   url: "https://fabricmc.net/wiki/tutorial:items",          category: "minecraft", namespace: "fabric", tags: ["item"] },
    { className: "net.minecraft.world.World",                 title: "World",               summary: "Represents a game world/dimension",                                     url: "https://fabricmc.net/wiki/tutorial:world",          category: "minecraft", namespace: "fabric", tags: ["world"] },
    { className: "net.minecraft.server.world.ServerWorld",    title: "ServerWorld",         summary: "Server-side world implementation",                                      url: "https://fabricmc.net/wiki/tutorial:world",          category: "minecraft", namespace: "fabric", tags: ["world"] },
    { className: "net.minecraft.client.world.ClientWorld",    title: "ClientWorld",         summary: "Client-side world implementation",                                      url: "https://fabricmc.net/wiki/tutorial:world",          category: "minecraft", namespace: "fabric", tags: ["world"] },
    { className: "net.minecraft.nbt.NbtCompound",             title: "NbtCompound",         summary: "Named Binary Tag compound for data serialization",                      url: "https://fabricmc.net/wiki/tutorial:nbt",            category: "minecraft", namespace: "fabric", tags: ["nbt"] },
    { className: "net.minecraft.util.Identifier",             title: "Identifier",          summary: "Namespaced identifier (e.g., minecraft:stone)",                         url: "https://fabricmc.net/wiki/tutorial:identifiers",    category: "minecraft", namespace: "fabric", tags: ["identifier"] },
    { className: "net.minecraft.util.math.BlockPos",          title: "BlockPos",            summary: "Immutable integer position in the world",                               url: "https://fabricmc.net/wiki/tutorial:blockpos",       category: "minecraft", namespace: "fabric", tags: ["math"] },
    { className: "net.minecraft.util.math.Vec3d",             title: "Vec3d",               summary: "Double-precision 3D vector",                                            url: "https://fabricmc.net/wiki/tutorial:vectors",        category: "minecraft", namespace: "fabric", tags: ["math"] },
    { className: "net.minecraft.text.Text",                   title: "Text",                summary: "Rich text component for chat and UI",                                   url: "https://fabricmc.net/wiki/tutorial:text",           category: "minecraft", namespace: "fabric", tags: ["text"] },
    { className: "net.minecraft.screen.ScreenHandler",        title: "ScreenHandler",       summary: "Manages inventory screen logic (like container)",                       url: "https://fabricmc.net/wiki/tutorial:screenhandler",  category: "minecraft", namespace: "fabric", tags: ["gui"] },
    { className: "net.minecraft.recipe.Recipe",               title: "Recipe",              summary: "Base interface for crafting recipes",                                   url: "https://fabricmc.net/wiki/tutorial:recipes",        category: "minecraft", namespace: "fabric", tags: ["recipe"] },
    { className: "net.minecraft.registry.Registry",           title: "Registry",            summary: "Game registry for blocks, items, entities, etc.",                      url: "https://fabricmc.net/wiki/tutorial:registry",       category: "minecraft", namespace: "fabric", tags: ["registry"] },
    { className: "net.minecraft.sound.SoundEvent",            title: "SoundEvent",          summary: "Represents a sound that can be played",                                 url: "https://fabricmc.net/wiki/tutorial:sounds",         category: "minecraft", namespace: "fabric", tags: ["sound"] },
    { className: "net.minecraft.particle.ParticleEffect",     title: "ParticleEffect",      summary: "Particle effect that can be spawned",                                   url: "https://fabricmc.net/wiki/tutorial:particles",      category: "minecraft", namespace: "fabric", tags: ["particle"] },

    // ── Fabric Wiki topic pages ──
    { title: "Mixin Introduction",        summary: "How to write Mixin classes to inject into Minecraft",        url: "https://fabricmc.net/wiki/tutorial:mixin_introduction", category: "fabric", namespace: "fabric", tags: ["mixin"] },
    { title: "Access Wideners",           summary: "How to widen access to private/protected members",           url: "https://fabricmc.net/wiki/tutorial:accesswideners",     category: "fabric", namespace: "fabric", tags: ["access-widener"] },
    { title: "Fabric Events",             summary: "Fabric event system for hooking game behaviour",             url: "https://fabricmc.net/wiki/tutorial:events",             category: "fabric", namespace: "fabric", tags: ["events"] },
    { title: "Fabric Networking",         summary: "Client↔Server packet networking with Fabric API",           url: "https://fabricmc.net/wiki/tutorial:networking",         category: "fabric", namespace: "fabric", tags: ["networking"] },
    { title: "Fabric Commands",           summary: "Registering Brigadier commands with Fabric",                url: "https://fabricmc.net/wiki/tutorial:commands",           category: "fabric", namespace: "fabric", tags: ["commands"] },
    { title: "Fabric Rendering",          summary: "Custom rendering with Fabric Rendering API",                url: "https://fabricmc.net/wiki/tutorial:rendering",          category: "fabric", namespace: "fabric", tags: ["rendering"] },
    { title: "Fabric Block Entities",     summary: "BlockEntity (tile entity) guide for Fabric",               url: "https://fabricmc.net/wiki/tutorial:blockentity",        category: "fabric", namespace: "fabric", tags: ["block", "block-entity"] },
    { title: "Fabric Data Generation",    summary: "Data generator for recipes, loot tables, tags etc.",        url: "https://fabricmc.net/wiki/tutorial:datagen",            category: "fabric", namespace: "fabric", tags: ["datagen"] },

    // ── NeoForge docs ──
    { title: "NeoForge Events",           summary: "NeoForge event bus system (IEventBus, @SubscribeEvent)",    url: "https://docs.neoforged.net/docs/concepts/events",           category: "neoforge", namespace: "neoforge", tags: ["events"] },
    { title: "NeoForge Capabilities",     summary: "Capability system for attaching data to blocks/entities",   url: "https://docs.neoforged.net/docs/datastorage/capabilities",  category: "neoforge", namespace: "neoforge", tags: ["capabilities"] },
    { title: "NeoForge Registries",       summary: "DeferredRegister and NewRegistryEvent",                     url: "https://docs.neoforged.net/docs/concepts/registries",       category: "neoforge", namespace: "neoforge", tags: ["registry"] },
    { title: "NeoForge Networking",       summary: "SimpleChannel networking in NeoForge",                      url: "https://docs.neoforged.net/docs/networking",                category: "neoforge", namespace: "neoforge", tags: ["networking"] },
    { title: "NeoForge Access Transformers", summary: "Access Transformer format for NeoForge",                url: "https://docs.neoforged.net/docs/advanced/accesstransformers", category: "neoforge", namespace: "neoforge", tags: ["access-transformer"] },
    { title: "NeoForge Mixins",           summary: "Using Mixin with NeoForge",                                url: "https://docs.neoforged.net/docs/advanced/mixins",            category: "neoforge", namespace: "neoforge", tags: ["mixin"] },
    { title: "NeoForge Data Maps",        summary: "JSON-driven data attachment to game objects",               url: "https://docs.neoforged.net/docs/resources/server/datamaps", category: "neoforge", namespace: "neoforge", tags: ["data"] },
    { title: "NeoForge Configuration",    summary: "TOML config files with NeoForge",                          url: "https://docs.neoforged.net/docs/misc/config",               category: "neoforge", namespace: "neoforge", tags: ["config"] },
    { title: "NeoForge Tags",             summary: "Block/item/entity tags in NeoForge",                        url: "https://docs.neoforged.net/docs/resources/server/tags",     category: "neoforge", namespace: "neoforge", tags: ["tags"] },
    { title: "NeoForge Curios API",       summary: "Curios API for custom equipment slots",                     url: "https://github.com/TheIllusiveC4/Curios/wiki",              category: "mod", namespace: "neoforge", tags: ["curios", "equipment"] },

    // ── Parchment ──
    { title: "Parchment Mappings",        summary: "Community-maintained parameter names and javadocs for vanilla Minecraft (mojmap)", url: "https://parchmentmc.org/", category: "minecraft", namespace: "parchment", tags: ["mappings", "parchment"] },
    { title: "Yarn Mappings",             summary: "Fabric community mappings for Minecraft",                   url: "https://github.com/FabricMC/yarn",                          category: "fabric", namespace: "fabric",   tags: ["mappings", "yarn"] },
];

export async function seedDefaultDocumentation(): Promise<object> {
    const result = await ingestDocumentation(DEFAULT_DOCS.map(d => ({ ...d, source: "seed" })));
    return { seeded: true, ...(result as Record<string, unknown>) };
}

// ── embedding helpers ─────────────────────────────────────────────────────────

async function tryEmbedDoc(id: number, title: string, summary: string | null | undefined): Promise<void> {
    if (!await isOllamaAvailable()) return;
    try {
        const text = [title, summary].filter(Boolean).join(" ");
        const vec = await embed(text);
        await upsertDocEmbedding(id, vec);
    } catch { /* non-fatal */ }
}

// ── semantic_search ───────────────────────────────────────────────────────────

export async function semanticSearchDocumentation(query: string, limit = 10): Promise<object> {
    const vec = await embed(query);
    const rows = await searchDocsByVector(vec, limit);
    if (!rows.length) return { query, semantic: true, count: 0, results: [] };
    const ids = rows.map(r => r.id);
    const entries = await db().docEntry.findMany({ where: { id: { in: ids } } });
    const byId = Object.fromEntries(entries.map(e => [e.id, e]));
    const results = rows.map(r => ({ similarity: Math.round(r.similarity * 1000) / 1000, ...byId[r.id] }));
    return { query, semantic: true, count: results.length, results };
}

// ── backfill_embeddings ───────────────────────────────────────────────────────

export async function backfillDocEmbeddings(): Promise<object> {
    if (!await isOllamaAvailable()) {
        return { error: "Ollama is not available. Set OLLAMA_URL and ensure Ollama is running." };
    }
    const rows = await db().docEntry.findMany({ select: { id: true, title: true, summary: true } });
    const unembedded = await countUnembedded("doc_entries");
    let done = 0; let failed = 0;
    for (const row of rows) {
        try {
            const text = [row.title, row.summary].filter(Boolean).join(" ");
            const vec = await embed(text);
            await upsertDocEmbedding(row.id, vec);
            done++;
        } catch { failed++; }
    }
    return { total: rows.length, wasUnembedded: unembedded, embedded: done, failed };
}
