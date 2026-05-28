/**
 * Distributable embedding bundles — export, import, and download pre-computed
 * embeddings so users don't need Ollama to get semantic search.
 */
import { createHash } from "crypto";
import { createGzip, createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { createReadStream, createWriteStream } from "fs";
import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { paths, exists, CACHE_ROOT } from "../cache.js";
import { getDb } from "../db.js";
import { findModById } from "../repositories/mod.js";
import {
    upsertModSourceEmbedding,
    findModSourceIdsByClassNames,
    upsertSourceEmbedding,
    findSourceIdsByClassNames,
} from "../repositories/embeddings.js";
import { findMcVersionByVersionId } from "../repositories/mcVersion.js";
import { validateDbId } from "../validate.js";
import { validateEmbeddingBundle } from "../security.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EmbeddingEntry {
    className: string;
    embedding: number[];
}

interface EmbeddingBundle {
    version: 1;
    model: string;
    dimensions: number;
    chunkSize: number;
    targetType: "mod" | "vanilla" | "modloader";
    targetId: string;
    targetVersion: string;
    loader?: string;
    mcVersion?: string;
    // Legacy fields (kept for backward compatibility with early bundles)
    modId?: string;
    modVersion?: string;
    generatedAt: string;
    entries: EmbeddingEntry[];
}

interface EmbedRegistryEntry {
    targetType: "mod" | "vanilla" | "modloader";
    targetId: string;
    targetVersion: string;
    loader?: string;
    mcVersion?: string;
    model: string;
    dimensions: number;
    entryCount: number;
    sizeBytes: number;
    sha256: string;
    url: string;
}

interface EmbedRegistry {
    version: 1;
    models: string[];
    bundles: EmbedRegistryEntry[];
}

type TargetType = "mod" | "vanilla" | "modloader";

type EmbedTarget = {
    targetType: TargetType;
    targetId: string;
    targetVersion: string;
    loader?: string;
    mcVersion?: string;
};

function normalizeBundleTarget(bundle: EmbeddingBundle): EmbedTarget {
    const targetType = bundle.targetType ?? "mod";
    if (targetType === "mod") {
        return {
            targetType,
            targetId: bundle.targetId ?? bundle.modId ?? "",
            targetVersion: bundle.targetVersion ?? bundle.modVersion ?? "",
            loader: bundle.loader,
            mcVersion: bundle.mcVersion,
        };
    }
    return {
        targetType,
        targetId: bundle.targetId,
        targetVersion: bundle.targetVersion,
        loader: bundle.loader,
        mcVersion: bundle.mcVersion,
    };
}

// ── Export ─────────────────────────────────────────────────────────────────────

/**
 * Export a mod's embeddings to a portable bundle file.
 */
export async function exportModEmbeddings(
    dbId: number,
    outputDir: string,
): Promise<{ path: string; entryCount: number; sizeBytes: number; sha256: string }> {
    validateDbId(dbId);
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    const dims = parseInt(process.env.OLLAMA_EMBED_DIM ?? "768", 10);
    const chunkSize = parseInt(process.env.OLLAMA_EMBED_CHUNK ?? "1500", 10);

    // Query all embedded source files
    const db = await getDb();
    const rows = await db.$queryRawUnsafe<Array<{ class_name: string; embedding: string }>>(
        `SELECT class_name, embedding::text AS embedding FROM mod_source_files
         WHERE mod_id = $1 AND embedding IS NOT NULL`,
        dbId,
    );

    if (rows.length === 0) {
        throw new Error(`No embeddings found for mod #${dbId} (${mod.modId}). Run index_semantic first.`);
    }

    const entries: EmbeddingEntry[] = rows.map(r => ({
        className: r.class_name,
        embedding: JSON.parse(r.embedding) as number[],
    }));

    const bundle: EmbeddingBundle = {
        version: 1,
        model,
        dimensions: dims,
        chunkSize,
        targetType: "mod",
        targetId: mod.modId,
        targetVersion: mod.version,
        loader: mod.loader,
        mcVersion: mod.mcVersion,
        modId: mod.modId,
        modVersion: mod.version,
        generatedAt: new Date().toISOString(),
        entries,
    };

    // Write gzipped bundle
    const modelDir = join(outputDir, model);
    await mkdir(modelDir, { recursive: true });
    const filename = `${mod.modId}-${mod.version}.emb.json.gz`;
    const outPath = join(modelDir, filename);

    const json = JSON.stringify(bundle);
    const gzip = createGzip();
    const ws = createWriteStream(outPath);
    await pipeline(Readable.from(json), gzip, ws);

    // Compute SHA-256 of the gzipped file
    const fileData = await readFile(outPath);
    const sha256 = createHash("sha256").update(fileData).digest("hex");
    const sizeBytes = fileData.length;

    return { path: outPath, entryCount: entries.length, sizeBytes, sha256 };
}

export async function exportVanillaEmbeddings(
    mcVersion: string,
    outputDir: string,
): Promise<{ path: string; entryCount: number; sizeBytes: number; sha256: string }> {
    const versionRow = await findMcVersionByVersionId(mcVersion);
    if (!versionRow) throw new Error(`MC version ${mcVersion} not found. Run mc_source index first.`);

    const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    const dims = parseInt(process.env.OLLAMA_EMBED_DIM ?? "768", 10);
    const chunkSize = parseInt(process.env.OLLAMA_EMBED_CHUNK ?? "1500", 10);

    const db = await getDb();
    const rows = await db.$queryRawUnsafe<Array<{ class_name: string; embedding: string }>>(
        `SELECT class_name, embedding::text AS embedding FROM mc_source_files
         WHERE mc_version_id = $1 AND embedding IS NOT NULL`,
        versionRow.id,
    );

    if (rows.length === 0) {
        throw new Error(`No vanilla embeddings found for MC ${mcVersion}. Run mc_source index_semantic first.`);
    }

    const entries: EmbeddingEntry[] = rows.map(r => ({
        className: r.class_name,
        embedding: JSON.parse(r.embedding) as number[],
    }));

    const bundle: EmbeddingBundle = {
        version: 1,
        model,
        dimensions: dims,
        chunkSize,
        targetType: "vanilla",
        targetId: "minecraft",
        targetVersion: mcVersion,
        loader: "vanilla",
        mcVersion,
        generatedAt: new Date().toISOString(),
        entries,
    };

    const modelDir = join(outputDir, model);
    await mkdir(modelDir, { recursive: true });
    const filename = `vanilla-${mcVersion}.emb.json.gz`;
    const outPath = join(modelDir, filename);

    const json = JSON.stringify(bundle);
    await pipeline(Readable.from(json), createGzip(), createWriteStream(outPath));

    const fileData = await readFile(outPath);
    const sha256 = createHash("sha256").update(fileData).digest("hex");
    const sizeBytes = fileData.length;

    return { path: outPath, entryCount: entries.length, sizeBytes, sha256 };
}

export async function exportEmbeddings(
    targetType: TargetType,
    outputDir: string,
    opts: { dbId?: number; mcVersion?: string } = {},
): Promise<{ path: string; entryCount: number; sizeBytes: number; sha256: string }> {
    if (targetType === "mod") {
        if (!opts.dbId) throw new Error("embed_export targetType=mod requires dbId");
        return exportModEmbeddings(opts.dbId, outputDir);
    }
    if (targetType === "vanilla") {
        if (!opts.mcVersion) throw new Error("embed_export targetType=vanilla requires mcVersion");
        return exportVanillaEmbeddings(opts.mcVersion, outputDir);
    }
    throw new Error("embed_export targetType=modloader is not supported yet");
}

/**
 * Export all mods with embeddings and generate an index.json manifest.
 */
export async function exportAllEmbeddings(
    outputDir: string,
): Promise<{ exported: number; skipped: number; indexPath: string }> {
    const db = await getDb();
    const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

    // Find all mods with at least one embedded source file
    const mods = await db.$queryRawUnsafe<Array<{ mod_id: number; count: string }>>(
        `SELECT mod_id, COUNT(*)::text AS count FROM mod_source_files
         WHERE embedding IS NOT NULL GROUP BY mod_id`,
    );

    let exported = 0;
    let skipped = 0;
    const entries: EmbedRegistryEntry[] = [];

    for (const row of mods) {
        try {
            const result = await exportModEmbeddings(row.mod_id, outputDir);
            const mod = await findModById(row.mod_id);
            if (!mod) continue;

            entries.push({
                targetType: "mod",
                targetId: mod.modId,
                targetVersion: mod.version,
                loader: mod.loader,
                mcVersion: mod.mcVersion,
                model,
                dimensions: parseInt(process.env.OLLAMA_EMBED_DIM ?? "768", 10),
                entryCount: result.entryCount,
                sizeBytes: result.sizeBytes,
                sha256: result.sha256,
                url: `${model}/${mod.modId}-${mod.version}.emb.json.gz`,
            });
            exported++;
        } catch {
            skipped++;
        }
    }

    // Write index.json
    const registry: EmbedRegistry = {
        version: 1,
        models: [model],
        bundles: entries,
    };
    const indexPath = join(outputDir, "index.json");
    await writeFile(indexPath, JSON.stringify(registry, null, 2));

    return { exported, skipped, indexPath };
}

// ── Import ────────────────────────────────────────────────────────────────────

/**
 * Import embeddings from a local bundle file into the database.
 */
export async function importEmbeddingsBundle(
    bundlePath: string,
): Promise<{ status: string; imported: number; skipped: number; total: number; bundleModel?: string; localModel?: string }> {
    // Read and decompress
    const compressed = await readFile(bundlePath);

    // Decompression bomb protection: reject >200MB compressed
    if (compressed.length > 200_000_000) {
        throw new Error("Compressed bundle too large (>200MB)");
    }

    // Decompress with size limit
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const MAX_DECOMPRESSED = 500_000_000; // 500MB

    const gunzip = createGunzip();
    const input = Readable.from(compressed);
    for await (const chunk of input.pipe(gunzip)) {
        totalSize += (chunk as Buffer).length;
        if (totalSize > MAX_DECOMPRESSED) {
            throw new Error("Decompressed bundle exceeds 500MB — possible decompression bomb");
        }
        chunks.push(chunk as Buffer);
    }

    const json = Buffer.concat(chunks).toString("utf8");
    const bundle = JSON.parse(json) as EmbeddingBundle;

    // Security validation
    const validation = validateEmbeddingBundle(bundle);
    if (!validation.valid) {
        throw new Error(`Bundle validation failed: ${validation.reason}`);
    }

    // Model mismatch check
    const localModel = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    const localDims = parseInt(process.env.OLLAMA_EMBED_DIM ?? "768", 10);

    if (bundle.model !== localModel || bundle.dimensions !== localDims) {
        return {
            status: "model_mismatch",
            imported: 0,
            skipped: bundle.entries.length,
            total: bundle.entries.length,
            bundleModel: `${bundle.model} (${bundle.dimensions}d)`,
            localModel: `${localModel} (${localDims}d)`,
        };
    }

    const target = normalizeBundleTarget(bundle);
    const classNames = bundle.entries.map(e => e.className);

    let idMap: Map<string, number>;
    if (target.targetType === "mod") {
        const db = await getDb();
        const mod = await db.$queryRawUnsafe<Array<{ id: number }>>(
            `SELECT id FROM mods WHERE mod_id = $1 AND version = $2 LIMIT 1`,
            target.targetId,
            target.targetVersion,
        );
        if (!mod.length) {
            return { status: "mod_not_found", imported: 0, skipped: bundle.entries.length, total: bundle.entries.length };
        }
        idMap = await findModSourceIdsByClassNames(classNames, mod[0].id);
    } else if (target.targetType === "vanilla") {
        const versionRow = await findMcVersionByVersionId(target.targetVersion);
        if (!versionRow) {
            return { status: "mc_version_not_found", imported: 0, skipped: bundle.entries.length, total: bundle.entries.length };
        }
        idMap = await findSourceIdsByClassNames(classNames, versionRow.id);
    } else {
        return {
            status: "not_supported",
            imported: 0,
            skipped: bundle.entries.length,
            total: bundle.entries.length,
        };
    }

    let imported = 0;
    let skipped = 0;

    for (const entry of bundle.entries) {
        const sourceFileId = idMap.get(entry.className);
        if (!sourceFileId) {
            skipped++;
            continue;
        }
        if (target.targetType === "mod") {
            await upsertModSourceEmbedding(sourceFileId, entry.embedding);
        } else if (target.targetType === "vanilla") {
            await upsertSourceEmbedding(sourceFileId, entry.embedding);
        }
        imported++;
    }

    return { status: "ok", imported, skipped, total: bundle.entries.length };
}

export async function importModEmbeddings(
    bundlePath: string,
): Promise<{ status: string; imported: number; skipped: number; total: number; bundleModel?: string; localModel?: string }> {
    return importEmbeddingsBundle(bundlePath);
}

// ── Download from registry ────────────────────────────────────────────────────

const EMBED_REGISTRY_URL = process.env.MODLENS_EMBED_REGISTRY_URL ??
    "https://raw.githubusercontent.com/Mattabase/modlens-embeddings/main/index.json";

let cachedEmbedRegistry: { data: EmbedRegistry; fetchedAt: number } | null = null;
const REGISTRY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchEmbedRegistry(): Promise<EmbedRegistry> {
    if (cachedEmbedRegistry && Date.now() - cachedEmbedRegistry.fetchedAt < REGISTRY_CACHE_TTL) {
        return cachedEmbedRegistry.data;
    }

    const res = await fetch(EMBED_REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) {
        const empty: EmbedRegistry = { version: 1, models: [], bundles: [] };
        cachedEmbedRegistry = { data: empty, fetchedAt: Date.now() };
        return empty;
    }
    if (!res.ok) throw new Error(`Failed to fetch embedding registry: ${res.status}`);

    const data = await res.json() as EmbedRegistry;
    if (!data.version || !Array.isArray(data.bundles)) {
        throw new Error("Invalid embedding registry format");
    }

    cachedEmbedRegistry = { data, fetchedAt: Date.now() };
    return data;
}

/**
 * Download and import pre-computed embeddings for a specific target.
 */
export async function downloadEmbeddings(
    target: {
        targetType: TargetType;
        targetId?: string;
        targetVersion?: string;
        dbId?: number;
        model?: string;
    },
): Promise<{ status: string; source?: string; imported?: number; skipped?: number; availableModels?: string[] }> {
    const localModel = target.model ?? process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    if (target.targetType === "modloader") {
        return { status: "not_supported", source: "modloader embeddings are not supported yet" };
    }

    let resolvedTargetId = target.targetId;
    let resolvedTargetVersion = target.targetVersion;
    if (target.targetType === "mod" && (!resolvedTargetId || !resolvedTargetVersion) && target.dbId != null) {
        const mod = await findModById(target.dbId);
        if (!mod) return { status: "mod_not_found", source: `Mod #${target.dbId} not found` };
        resolvedTargetId = resolvedTargetId ?? mod.modId;
        resolvedTargetVersion = resolvedTargetVersion ?? mod.version;
    }
    if (!resolvedTargetId || !resolvedTargetVersion) {
        return { status: "invalid_target", source: "targetId and targetVersion are required" };
    }

    let registry: EmbedRegistry;
    try {
        registry = await fetchEmbedRegistry();
    } catch (e) {
        return { status: "registry_unavailable", source: (e as Error).message };
    }

    // Find matching bundle for user's model
    const matchingBundles = registry.bundles.filter((b) => {
        const bundleType = b.targetType ?? "mod";
        return bundleType === target.targetType
            && b.targetId === resolvedTargetId
            && b.targetVersion === resolvedTargetVersion;
    });

    const entry = matchingBundles.find((b) => b.model === localModel);

    if (!entry) {
        const otherModels = [...new Set(matchingBundles.map((b) => b.model))];
        return {
            status: "not_found",
            availableModels: otherModels.length ? otherModels : undefined,
        };
    }

    // Resolve URL
    let bundleUrl = entry.url;
    if (!bundleUrl.startsWith("http")) {
        const base = EMBED_REGISTRY_URL.substring(0, EMBED_REGISTRY_URL.lastIndexOf("/") + 1);
        bundleUrl = base + bundleUrl;
    }

    if (!bundleUrl.startsWith("https://")) {
        throw new Error("Bundle URL must use HTTPS");
    }

    // Download
    const res = await fetch(bundleUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Failed to download bundle: ${res.status}`);

    const contentLength = parseInt(res.headers.get("content-length") ?? "0");
    if (contentLength > 200_000_000) throw new Error("Bundle too large (>200MB)");

    const data = Buffer.from(await res.arrayBuffer());

    // Verify SHA-256
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== entry.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${entry.sha256}, got ${hash}`);
    }

    // Save to cache and import
    const bundleDir = paths.embedBundles;
    await mkdir(bundleDir, { recursive: true });
    const safeId = resolvedTargetId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeVer = resolvedTargetVersion.replace(/[^a-zA-Z0-9._-]/g, "_");
    const localPath = join(bundleDir, `${target.targetType}-${safeId}-${safeVer}.emb.json.gz`);
    await writeFile(localPath, data);

    const result = await importEmbeddingsBundle(localPath);
    return {
        status: result.status,
        imported: result.imported,
        skipped: result.skipped,
    };
}

/**
 * Download embeddings for all ingested mods that don't have them yet.
 */
export async function downloadPackEmbeddings(): Promise<{
    downloaded: number;
    alreadyEmbedded: number;
    notAvailable: number;
}> {
    const db = await getDb();

    // Get all mods
    const allMods = await db.$queryRawUnsafe<Array<{ id: number; mod_id: string; version: string }>>(
        `SELECT id, mod_id, version FROM mods ORDER BY mod_id`,
    );

    // Check which have embeddings
    const embedded = await db.$queryRawUnsafe<Array<{ mod_id: number }>>(
        `SELECT DISTINCT mod_id FROM mod_source_files WHERE embedding IS NOT NULL`,
    );
    const embeddedSet = new Set(embedded.map(r => r.mod_id));

    let downloaded = 0;
    let alreadyEmbedded = 0;
    let notAvailable = 0;

    for (const mod of allMods) {
        if (embeddedSet.has(mod.id)) {
            alreadyEmbedded++;
            continue;
        }

        try {
            const result = await downloadEmbeddings({
                targetType: "mod",
                targetId: mod.mod_id,
                targetVersion: mod.version,
            });
            if (result.status === "ok" && (result.imported ?? 0) > 0) {
                downloaded++;
            } else {
                notAvailable++;
            }
        } catch {
            notAvailable++;
        }
    }

    return { downloaded, alreadyEmbedded, notAvailable };
}

/**
 * Get embedding status for a mod.
 */
export async function getEmbedStatus(
    target: { targetType: TargetType; dbId?: number; mcVersion?: string },
): Promise<{ totalFiles: number; embeddedCount: number; model: string; coverage: string }> {
    const db = await getDb();
    let stats: [{ total: string; embedded: string }];

    if (target.targetType === "mod") {
        if (target.dbId == null) throw new Error("embed_status targetType=mod requires dbId");
        validateDbId(target.dbId);
        const mod = await findModById(target.dbId);
        if (!mod) throw new Error(`Mod #${target.dbId} not found`);
        stats = await db.$queryRawUnsafe<[{ total: string; embedded: string }]>(
            `SELECT COUNT(*)::text AS total,
                    COUNT(CASE WHEN embedding IS NOT NULL THEN 1 END)::text AS embedded
             FROM mod_source_files WHERE mod_id = $1`,
            target.dbId,
        );
    } else if (target.targetType === "vanilla") {
        if (!target.mcVersion) throw new Error("embed_status targetType=vanilla requires mcVersion");
        const versionRow = await findMcVersionByVersionId(target.mcVersion);
        if (!versionRow) throw new Error(`MC version ${target.mcVersion} not found`);
        stats = await db.$queryRawUnsafe<[{ total: string; embedded: string }]>(
            `SELECT COUNT(*)::text AS total,
                    COUNT(CASE WHEN embedding IS NOT NULL THEN 1 END)::text AS embedded
             FROM mc_source_files WHERE mc_version_id = $1`,
            versionRow.id,
        );
    } else {
        throw new Error("embed_status targetType=modloader is not supported yet");
    }

    const total = parseInt(stats[0].total, 10);
    const embedded = parseInt(stats[0].embedded, 10);
    const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    const coverage = total > 0 ? `${Math.round((embedded / total) * 100)}%` : "0%";

    return { totalFiles: total, embeddedCount: embedded, model, coverage };
}
