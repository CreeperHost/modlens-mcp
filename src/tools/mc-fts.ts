/**
 * PostgreSQL full-text search for vanilla Minecraft source.
 * index_minecraft_version: walks a completed Vineflower decompile, stores
 *   source in the mc_source_files table.
 * search_mc_indexed: runs a fast FTS query via to_tsvector('simple', content).
 *
 * The GIN index is created automatically by `npm run db:setup`.
 * (scripts/create-fts-index.mjs — runs after prisma migrate deploy)
 */
import { readFile, readdir } from "fs/promises";
import { join, relative } from "path";
import { mcPaths, fetchMcVersionList } from "../minecraft.js";
import { isDecompileDone } from "../java-tools.js";
import { exists } from "../cache.js";
import { ensureMcVersion, findMcVersionById, findMcVersionByVersionId, updateMcVersion, upsertMcSourceFile, searchMcSourceFiles } from "../repositories/mcVersion.js";
import { findModById, upsertModSourceFile, findModSourceFilesUnembedded, countUnembeddedModSourceFiles } from "../repositories/mod.js";
import { embed, isOllamaAvailable, chunkText } from "../embeddings.js";
import { upsertSourceEmbedding, searchSourceByVector, countUnembedded, upsertModSourceEmbedding, searchModSourceByVector } from "../repositories/embeddings.js";

async function ensureMcVersionRecord(version: string): Promise<number> {
    return ensureMcVersion(version);
}

/** Collect all .java file paths under a directory tree. */
async function collectJavaFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...await collectJavaFiles(full));
        else if (e.name.endsWith(".java")) out.push(full);
    }
    return out;
}

/**
 * index_minecraft_version
 * Reads the already-decompiled source tree and upserts every .java file
 * into mc_source_files for FTS. Decompilation must have finished first
 * (run decompile_minecraft_version and wait for status "done").
 */
export async function indexMcVersion(version: string, force = false): Promise<{
    status: string; indexed: number; skipped: number;
}> {
    const outDir = mcPaths.decompiled(version);
    const decompStatus = await isDecompileDone(outDir);
    if (decompStatus !== "done") {
        throw new Error(
            `MC ${version} decompile is not complete (status: ${decompStatus}). ` +
            `Run decompile_minecraft_version("${version}") first.`
        );
    }

    const mcVersionId = await ensureMcVersionRecord(version);

    if (!force) {
        const existing = await findMcVersionById(mcVersionId);
        if (existing?.indexed) return { status: "already_indexed", indexed: 0, skipped: 0 };
    }

    const javaFiles = await collectJavaFiles(outDir);
    let indexed = 0;
    let skipped = 0;

    // Batch upserts in chunks of 50 to avoid huge transactions
    const BATCH = 50;
    for (let i = 0; i < javaFiles.length; i += BATCH) {
        const chunk = javaFiles.slice(i, i + BATCH);
        for (const filePath of chunk) {
            const relPath = relative(outDir, filePath);
            // Convert path to internal class name: com/example/Foo.java → com/example/Foo
            const className = relPath.replace(/\\/g, "/").replace(/\.java$/, "");
            try {
                const content = await readFile(filePath, "utf8");
                await upsertMcSourceFile(mcVersionId, className, content);
                indexed++;
            } catch {
                skipped++;
            }
        }
    }

    await updateMcVersion(mcVersionId, { indexed: true });

    return { status: "done", indexed, skipped };
}

interface FtsRow { class_name: string; snippet: string; }

/**
 * search_mc_indexed
 * Fast FTS search over indexed MC source. Supports:
 *   - Plain text / keyword queries (uses plainto_tsquery 'simple' config — no stemming)
 *   - Boolean: "Entity AND tick", "player OR entity", "hurt -damage"
 *   - Phrase: wrap in double-quotes passed as tsquery: '"onHurt"'
 */
export async function searchMcIndexed(
    query: string,
    version: string,
    limit = 20,
): Promise<Array<{ className: string; snippet: string }>> {
    const row = await findMcVersionByVersionId(version);
    if (!row) {
        throw new Error(`Version "${version}" is not in the database. Run index_minecraft_version("${version}") first.`);
    }
    return searchMcSourceFiles(row.id, query, limit);
}

/**
 * Returns true if the FTS index has been built for this MC version.
 * Checks `indexed` flag on the McVersion row.
 */
export async function isMcVersionIndexed(version: string): Promise<boolean> {
    const row = await findMcVersionByVersionId(version);
    return row?.indexed === true;
}

// ── Semantic indexing ─────────────────────────────────────────────────────────

/**
 * index_mc_source_semantic
 * Embeds MC source files for a version using Ollama. Processes files that have
 * no embedding yet (safe to re-run / resume after interruption).
 *
 * Only embeds the first chunk (class header ~1500 chars) — enough for semantic
 * class-level search without spending hours on full-file embedding.
 *
 * @param version    MC version string e.g. "26.1.2"
 * @param batchSize  Files per batch (pause between batches to avoid OOM)
 */
export async function indexMcSourceSemantic(
    version: string,
    batchSize = 50,
): Promise<{ status: string; embedded: number; skipped: number; remaining: number }> {
    if (!await isOllamaAvailable()) {
        throw new Error("Ollama is not available. Set OLLAMA_URL and ensure Ollama is running with `ollama pull nomic-embed-text`.");
    }
    const row = await findMcVersionByVersionId(version);
    if (!row) {
        throw new Error(`Version "${version}" is not in the database. Run index_minecraft_version("${version}") first.`);
    }
    const mcVersionId = row.id;
    const remaining0 = await countUnembedded("mc_source_files", mcVersionId);
    if (remaining0 === 0) {
        return { status: "already_embedded", embedded: 0, skipped: 0, remaining: 0 };
    }

    // Fetch rows without embeddings in batches
    let embedded = 0; let skipped = 0;
    let offset = 0;
    while (true) {
        const { getDb } = await import("../db.js");
        const _db = await getDb();
        const batch = await _db.$queryRawUnsafe<Array<{ id: number; class_name: string; content: string }>>(
            `SELECT id, class_name, content FROM mc_source_files
             WHERE mc_version_id = $1 AND embedding IS NULL
             ORDER BY id LIMIT $2 OFFSET $3`,
            mcVersionId, batchSize, offset,
        );
        if (!batch.length) break;
        for (const file of batch) {
            try {
                // Only embed the first chunk — enough for class-level semantic search
                const chunk = chunkText(file.content, 1500)[0];
                const vec = await embed(chunk);
                await upsertSourceEmbedding(file.id, vec);
                embedded++;
            } catch { skipped++; }
        }
        offset += batch.length;
        // Small pause to avoid overwhelming Ollama
        await new Promise(r => setTimeout(r, 50));
    }

    const remaining = await countUnembedded("mc_source_files", mcVersionId);
    return { status: "done", embedded, skipped, remaining };
}

/**
 * search_mc_source_semantic
 * Semantic (vector) search over embedded MC source files.
 * Falls back to FTS if Ollama is unavailable.
 */
export async function searchMcSourceSemantic(
    query: string,
    version: string,
    limit = 10,
): Promise<Array<{ className: string; similarity: number }>> {
    const row = await findMcVersionByVersionId(version);
    if (!row) {
        throw new Error(`Version "${version}" is not in the database. Run index_minecraft_version("${version}") first.`);
    }
    const vec = await embed(query);
    const rows = await searchSourceByVector(vec, row.id, limit);
    return rows.map(r => ({ className: r.class_name, similarity: Math.round(r.similarity * 1000) / 1000 }));
}

// ── Mod source semantic index / search ────────────────────────────────────────

/**
 * index_mod_source_semantic
 * Walks the decompiled source tree of a mod (by dbId), upserts each .java file
 * into mod_source_files, then embeds each file in batches using Ollama.
 */
export async function indexModSourceSemantic(
    dbId: number,
    batchSize = 50,
): Promise<{ status: string; indexed: number; embedded: number; skipped: number; remaining: number }> {
    if (!await isOllamaAvailable()) {
        throw new Error("Ollama is not available. Set OLLAMA_URL and ensure Ollama is running with `ollama pull nomic-embed-text`.");
    }
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    if (!mod.decompPath) throw new Error(`Mod #${dbId} has no decompiled source. Run mod decompile first.`);

    // Walk and upsert all .java files
    const javaFiles = await collectJavaFiles(mod.decompPath);
    let indexed = 0; let skipped = 0;
    const BATCH = 50;
    for (let i = 0; i < javaFiles.length; i += BATCH) {
        for (const filePath of javaFiles.slice(i, i + BATCH)) {
            const relPath = relative(mod.decompPath, filePath);
            const className = relPath.replace(/\\/g, "/").replace(/\.java$/, "");
            try {
                const content = await readFile(filePath, "utf8");
                await upsertModSourceFile(dbId, className, content);
                indexed++;
            } catch { skipped++; }
        }
    }

    // Embed in batches
    let embedded = 0; let offset = 0;
    while (true) {
        const batch = await findModSourceFilesUnembedded(dbId, batchSize, offset);
        if (!batch.length) break;
        for (const file of batch) {
            try {
                const chunk = chunkText(file.content, 1500)[0];
                const vec = await embed(chunk);
                await upsertModSourceEmbedding(file.id, vec);
                embedded++;
            } catch { skipped++; }
        }
        offset += batch.length;
        await new Promise(r => setTimeout(r, 50));
    }

    const remaining = await countUnembeddedModSourceFiles(dbId);
    return { status: "done", indexed, embedded, skipped, remaining };
}

/**
 * search_mod_source_semantic
 * Semantic (vector) search over embedded mod source files for a given dbId.
 */
export async function searchModSourceSemantic(
    query: string,
    dbId: number,
    limit = 10,
): Promise<Array<{ className: string; modId: string; similarity: number }>> {
    if (!await isOllamaAvailable()) {
        throw new Error("Ollama is not available. Set OLLAMA_URL and ensure Ollama is running with `ollama pull nomic-embed-text`.");
    }
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    const vec = await embed(query);
    const rows = await searchModSourceByVector(vec, dbId, limit);
    return rows.map(r => ({
        className: r.class_name,
        modId: mod.modId,
        similarity: Math.round(r.similarity * 1000) / 1000,
    }));
}
