import { parseJar, computeHashes, METADATA_QUALITY } from "../processor.js";
import type { MetadataSource } from "../processor.js";
import { modrinthPlatformAdapter } from "../modrinth.js";
import { curseforgePlatformAdapter } from "../curseforge.js";
import type { PlatformHit } from "../platform-adapter.js";
import { decompileJar, decompileJarJiJ, isDecompileDone } from "../java-tools.js";
import { indexJar } from "../java-tools.js";
import { paths, ensureDir } from "../cache.js";
import { join } from "path";
import { rm } from "fs/promises";
import { normalizeJarPath, assertJarPath } from "../security.js";
import { isOllamaAvailable } from "../embeddings.js";
import { enqueueModEmbed } from "../embed-queue.js";
import { buildModGraph, ensureGraphify } from "./graphify.js";
import {
    findModByJarPath, findModByDupKey, findModBySha512,
    createMod, updateMod, findModById, listAllMods,
    countModClasses, createModClasses, findModByModId, deleteModById,
    listModsSlim,
} from "../repositories/mod.js";
import { getDb } from "../db.js";
import { validateDbId } from "../validate.js";

// ── IngestResult discriminated union ─────────────────────────────────────────

export type IngestResult =
    | { status: "already_ingested";  mod: Awaited<ReturnType<typeof findModById>> }
    | { status: "metadata_refreshed"; mod: Awaited<ReturnType<typeof findModById>>; previousSource: string }
    | { status: "duplicate_version"; message: string; existingJarPath: string; existingDbId: number }
    | { status: "duplicate_hash";    message: string; existingJarPath: string; existingDbId: number }
    | { status: "ingested";          mod: Awaited<ReturnType<typeof findModById>> }
    | { status: "replaced";          mod: Awaited<ReturnType<typeof findModById>>; replacedDbId: number };

// ── Platform adapter registry ─────────────────────────────────────────────────

const PLATFORM_ADAPTERS = [
    modrinthPlatformAdapter,
    curseforgePlatformAdapter,
];

async function lookupPlatforms(
    sha512: string | null,
    murmur2: string | null,
): Promise<PlatformHit[]> {
    const hashes = { sha512, murmur2 };
    const results = await Promise.allSettled(
        PLATFORM_ADAPTERS.map(a => a.lookup(hashes)),
    );
    return results
        .filter((r): r is PromiseFulfilledResult<PlatformHit | null> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((v): v is PlatformHit => v !== null);
}

// ── Main ingest ───────────────────────────────────────────────────────────────

export async function ingestMod(jarPath: string, skipSource = false, replace = false): Promise<IngestResult> {
    jarPath = normalizeJarPath(jarPath);
    const existing = await findModByJarPath(jarPath);
    if (existing) {
        // Re-parse to check if the JAR now has higher-quality metadata
        const oldSource = (existing.metadataSource ?? "filename") as MetadataSource;
        const oldQuality = METADATA_QUALITY[oldSource] ?? 0;
        if (oldQuality < 3) { // already at max quality? skip re-parse
            try {
                const manifest = await parseJar(jarPath);
                const newQuality = METADATA_QUALITY[manifest.metadataSource] ?? 0;
                if (newQuality > oldQuality) {
                    const updated = await updateMod(existing.id, {
                        modId:        manifest.modId,
                        displayName:  manifest.displayName,
                        version:      manifest.version,
                        mcVersion:    manifest.mcVersion,
                        loader:       manifest.loader,
                        hasMixins:    manifest.hasMixins,
                        hasAt:        manifest.hasAt,
                        hasAw:        manifest.hasAw,
                        mixinConfigs: manifest.mixinConfigs,
                        mixinTargets: manifest.mixinTargets,
                        atEntries:    manifest.atEntries,
                        awEntries:    manifest.awEntries,
                        dependencies: manifest.dependencies,
                        metadata:     { description: manifest.description, sourceUrl: manifest.sourceUrl },
                        metadataSource: manifest.metadataSource,
                    });
                    return { status: "metadata_refreshed", mod: updated, previousSource: oldSource };
                }
            } catch { /* re-parse failed, keep existing */ }
        }
        return { status: "already_ingested", mod: existing };
    }

    const manifest = await parseJar(jarPath);
    const hashes = await computeHashes(jarPath);

    // Guard: same modId+version+mcVersion+loader already ingested from a different path
    const duplicate = await findModByDupKey(
        manifest.modId, manifest.version, manifest.mcVersion, manifest.loader
    );
    if (duplicate) {
        if (!replace) {
            return {
                status: "duplicate_version",
                message: `${manifest.modId} ${manifest.version} (${manifest.loader} / ${manifest.mcVersion}) is already ingested from a different path.`,
                existingJarPath: duplicate.jarPath,
                existingDbId:    duplicate.id,
            };
        }
        await deleteModById(duplicate.id);
    }

    // In replace mode: delete any older version of this modId before inserting
    if (replace) {
        const older = await findModByModId(manifest.modId);
        if (older) await deleteModById(older.id);
    }

    // Guard: same file content (sha512) already ingested regardless of path
    if (hashes.sha512) {
        const bySha = await findModBySha512(hashes.sha512);
        if (bySha) {
            return {
                status: "duplicate_hash",
                message: `This JAR has the same SHA-512 as already-ingested mod '${bySha.modId}' (db id ${bySha.id}). Files are identical.`,
                existingJarPath: bySha.jarPath,
                existingDbId:    bySha.id,
            };
        }
    }

    const mod = await createMod({
        modId: manifest.modId,
        displayName: manifest.displayName,
        version: manifest.version,
        mcVersion: manifest.mcVersion,
        loader: manifest.loader,
        jarPath,
        sha256: hashes.sha256,
        sha512: hashes.sha512,
        murmur2: hashes.murmur2,
        hasMixins: manifest.hasMixins,
        hasAt: manifest.hasAt,
        hasAw: manifest.hasAw,
        mixinConfigs: manifest.mixinConfigs,
        mixinTargets: manifest.mixinTargets,
        atEntries: manifest.atEntries,
        awEntries: manifest.awEntries,
        dependencies: manifest.dependencies,
        metadata: { description: manifest.description, sourceUrl: manifest.sourceUrl },
        metadataSource: manifest.metadataSource,
    });

    if (!skipSource) {
        const hits = await lookupPlatforms(hashes.sha512, hashes.murmur2);
        let merged: Record<string, unknown> & { sourceUrl?: string | null } = { ...(mod.metadata as object) };

        for (const hit of hits) {
            if (hit.platform === "modrinth") {
                merged = {
                    ...merged,
                    modrinthSlug: hit.slug,
                    sourceUrl: merged.sourceUrl ?? hit.sourceUrl,
                };
                await updateMod(mod.id, {
                    modrinthId: hit.projectId,
                    metadata: merged as Parameters<typeof updateMod>[1]["metadata"],
                });
            } else {
                merged = {
                    ...merged,
                    cfSlug: hit.slug,
                    sourceUrl: merged.sourceUrl ?? hit.sourceUrl,
                };
                await updateMod(mod.id, {
                    curseforgeId: hit.projectId,
                    metadata: merged as Parameters<typeof updateMod>[1]["metadata"],
                });
            }
        }
    }

    // Index classes in background (non-blocking)
    indexJar(jarPath)
        .then(async (index) => {
            const classes = Object.values(index.classes);
            if (!classes.length) return;
            await createModClasses(classes.map((c) => ({
                modId: mod.id,
                className: c.name,
                superClass: c.superName || null,
                interfaces: c.interfaces,
                accessFlags: c.accessFlags,
            })));
        })
        .catch(() => { /* non-fatal — class index can be retried */ });

    return { status: "ingested", mod: await findModById(mod.id) };
}

/**
 * Ingest all JAR files in a directory. Skips already-ingested files.
 * Returns a per-file summary plus totals.
 */
export async function batchIngest(
    directory: string,
    skipSource = true,
    indexClasses = false,
    replace = false,
): Promise<object> {
    const { readdir } = await import("fs/promises");
    const { join, resolve } = await import("path");

    const absDir = resolve(normalizeJarPath(directory));
    let entries: string[];
    try {
        entries = await readdir(absDir);
    } catch (e) {
        throw new Error(`Cannot read directory: ${absDir} — ${e instanceof Error ? e.message : e}`);
    }

    const jars = entries.filter((f) => f.endsWith(".jar")).sort();
    if (jars.length === 0) return { directory: absDir, total: 0, ingested: 0, skipped: 0, failed: 0, results: [] };

    let ingested = 0, skipped = 0, failed = 0;
    const results: Array<{ file: string; status: string; modId?: string; version?: string; loader?: string }> = [];

    for (const jar of jars) {
        const jarPath = join(absDir, jar);
        try {
            const result = await ingestMod(jarPath, skipSource, replace);
            if (result.status === "already_ingested" || result.status === "duplicate_version" || result.status === "duplicate_hash") {
                skipped++;
                results.push({ file: jar, status: result.status });
            } else {
                ingested++;
                const mod = result.mod as { modId: string; version: string; loader: string; id: number };
                results.push({ file: jar, status: "ingested", modId: mod?.modId, version: mod?.version, loader: mod?.loader });
                if (indexClasses && mod?.id) {
                    await reindexClasses(mod.id).catch(() => { /* non-fatal */ });
                }
            }
        } catch (e) {
            failed++;
            results.push({ file: jar, status: `error: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
        }
    }

    return { directory: absDir, total: jars.length, ingested, skipped, failed, results };
}

// ── Batch refresh degraded metadata ───────────────────────────────────────────

export async function refreshDegradedMetadata(opts?: { loader?: string; mcVersion?: string }): Promise<{
    total: number; refreshed: number; unchanged: number; failed: number;
    results: Array<{ modId: string; dbId: number; status: string; previousSource?: string; newSource?: string }>;
}> {
    const db = await getDb();
    const where: Record<string, unknown> = {
        metadataSource: { in: ["filename", "@Mod annotation"] },
    };
    if (opts?.loader) where.loader = opts.loader;
    if (opts?.mcVersion) where.mcVersion = { contains: opts.mcVersion };

    const mods = await db.mod.findMany({ where, orderBy: { modId: "asc" } });
    let refreshed = 0, unchanged = 0, failed = 0;
    const results: Array<{ modId: string; dbId: number; status: string; previousSource?: string; newSource?: string }> = [];

    for (const mod of mods) {
        try {
            assertJarPath(mod.jarPath);
            const oldSource = (mod.metadataSource ?? "filename") as MetadataSource;
            const oldQuality = METADATA_QUALITY[oldSource] ?? 0;
            const manifest = await parseJar(mod.jarPath);
            const newQuality = METADATA_QUALITY[manifest.metadataSource] ?? 0;
            if (newQuality > oldQuality) {
                await updateMod(mod.id, {
                    modId:        manifest.modId,
                    displayName:  manifest.displayName,
                    version:      manifest.version,
                    mcVersion:    manifest.mcVersion,
                    loader:       manifest.loader,
                    hasMixins:    manifest.hasMixins,
                    hasAt:        manifest.hasAt,
                    hasAw:        manifest.hasAw,
                    mixinConfigs: manifest.mixinConfigs,
                    mixinTargets: manifest.mixinTargets,
                    atEntries:    manifest.atEntries,
                    awEntries:    manifest.awEntries,
                    dependencies: manifest.dependencies,
                    metadata:     { description: manifest.description, sourceUrl: manifest.sourceUrl },
                    metadataSource: manifest.metadataSource,
                });
                refreshed++;
                results.push({ modId: mod.modId, dbId: mod.id, status: "refreshed", previousSource: oldSource, newSource: manifest.metadataSource });
            } else {
                unchanged++;
                results.push({ modId: mod.modId, dbId: mod.id, status: "unchanged" });
            }
        } catch (e) {
            failed++;
            results.push({ modId: mod.modId, dbId: mod.id, status: `error: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
        }
    }

    return { total: mods.length, refreshed, unchanged, failed, results };
}

export async function reindexClasses(dbId?: number): Promise<{ indexed: number; failed: number; skipped: number; }> {
    if (dbId !== undefined) validateDbId(dbId);
    const mods = dbId !== undefined
        ? await findModById(dbId).then((m) => (m ? [m] : []))
        : await listAllMods();

    let indexed = 0, failed = 0, skipped = 0;

    for (const mod of mods) {
        const existing = await countModClasses(mod.id);
        if (existing > 0) { skipped++; continue; }
        try {
            assertJarPath(mod.jarPath);
            const index = await indexJar(mod.jarPath);
            const classes = Object.values(index.classes);
            if (!classes.length) { skipped++; continue; }
            await createModClasses(classes.map((c) => ({
                    modId: mod.id,
                    className: c.name,
                    superClass: c.superName || null,
                    interfaces: c.interfaces,
                    accessFlags: c.accessFlags,
                })));
            indexed++;
        } catch {
            failed++;
        }
    }

    return { indexed, failed, skipped };
}

export async function decompileMod(dbId: number): Promise<{ status: string; outDir: string; message: string }> {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    assertJarPath(mod.jarPath);

    const outDir = join(paths.decompiled(mod.modId, mod.version));

    // Check if already done
    const state = await isDecompileDone(outDir);
    if (state === "done") {
        await updateMod(dbId, { decompiled: true, decompPath: outDir });
        return { status: "done", outDir, message: "Already decompiled. Use get_mod_source to browse." };
    }
    if (state === "running") {
        return { status: "running", outDir, message: "Decompile already in progress. Poll decompile_mod_status to check." };
    }

    // Kick off background decompile — returns in ~300ms
    // decompileJarJiJ handles Jar-in-Jar bundles automatically (Fabric META-INF/jars/ + NeoForge META-INF/jarjar/)
    await decompileJarJiJ(mod.jarPath, outDir);

    return {
        status: "started",
        outDir,
        message: "Vineflower launched in background. Call decompile_mod_status with the same dbId to check progress. This avoids MCP timeout.",
    };
}

export interface AutoBehaviorOpts {
    autoEmbed?: boolean;
    autoGraph?: boolean;
}

/** Resolve an auto-behavior flag: explicit param > env var > default (true). */
function resolveAuto(explicit: boolean | undefined, envKey: string): boolean {
    if (explicit !== undefined) return explicit;
    const envVal = process.env[envKey];
    if (envVal === "0" || envVal === "false") return false;
    return true; // on by default
}

export async function decompileModStatus(
    dbId: number,
    opts?: AutoBehaviorOpts,
): Promise<{ status: string; outDir: string; message: string }> {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const outDir = join(paths.decompiled(mod.modId, mod.version));
    const state = await isDecompileDone(outDir);

    if (state === "done") {
        // Mark DB as done if not already, then auto-queue semantic embedding
        if (!mod.decompiled) {
            await updateMod(dbId, { decompiled: true, decompPath: outDir });
            // Fire-and-forget: enqueue for background semantic indexing if Ollama is available
            if (resolveAuto(opts?.autoEmbed, "MODLENS_AUTO_EMBED")) {
                isOllamaAvailable().then(available => {
                    if (available) enqueueModEmbed(dbId);
                }).catch(() => {});
            }
            // Fire-and-forget: auto-build knowledge graph if graphify is available
            if (resolveAuto(opts?.autoGraph, "MODLENS_AUTO_GRAPH")) {
                ensureGraphify().then(() => {
                    buildModGraph(dbId).catch(() => {});
                }).catch(() => {});
            }
        }
        return { status: "done", outDir, message: "Decompile complete. Use get_mod_source to browse." };
    }
    if (state === "error") {
        return { status: "error", outDir, message: "Vineflower exited with an error. Check the .decompile.error sentinel for exit code." };
    }
    if (state === "running") {
        return { status: "running", outDir, message: "Still decompiling..." };
    }
    return { status: "not_started", outDir, message: "No decompile job found. Call decompile_mod first." };
}

// ── Delete mod ────────────────────────────────────────────────────────────────

export async function deleteModFull(dbId: number): Promise<{ deleted: boolean; modId: string; cleaned: string[] }> {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const cleaned: string[] = [];

    // Remove decompiled source directory
    if (mod.decompPath) {
        try {
            await rm(mod.decompPath, { recursive: true, force: true });
            cleaned.push(`decompiled: ${mod.decompPath}`);
        } catch { /* already gone */ }
    }

    // Remove graph directory
    if (mod.graphPath) {
        try {
            // graphPath points to graphify-out/, remove the parent (graphs/{modId}/{version}/)
            const graphParent = join(mod.graphPath, "..");
            await rm(graphParent, { recursive: true, force: true });
            cleaned.push(`graph: ${mod.graphPath}`);
        } catch { /* already gone */ }
    }

    // Remove cached version-diff rows referencing this mod
    const db = await (await import("../db.js")).getDb();
    const diffCount = await db.modVersionDiff.deleteMany({
        where: { OR: [{ modDbIdA: dbId }, { modDbIdB: dbId }] },
    });
    if (diffCount.count > 0) cleaned.push(`version_diffs: ${diffCount.count}`);

    // Remove source files (FTS/semantic index)
    const srcCount = await db.modSourceFile.deleteMany({ where: { modId: dbId } });
    if (srcCount.count > 0) cleaned.push(`source_files: ${srcCount.count}`);

    // deleteModById handles ModTag, ModClass, and Mod rows
    await deleteModById(dbId);
    cleaned.push("db_rows: mod, classes, tags");

    return { deleted: true, modId: mod.modId, cleaned };
}

// ── Batch decompile ───────────────────────────────────────────────────────────

export async function batchDecompileMods(opts?: {
    concurrency?: number;
    autoEmbed?: boolean;
    autoGraph?: boolean;
}): Promise<{ started: number; alreadyDone: number; errors: number; total: number }> {
    const concurrency = opts?.concurrency ?? 4;
    const mods = await listModsSlim({ decompiled: false });
    let started = 0, alreadyDone = 0, errors = 0;

    // Batch auto-behaviors default OFF (unlike single-mod which defaults ON).
    // Uses MODLENS_BATCH_AUTO_EMBED / MODLENS_BATCH_AUTO_GRAPH with explicit param override.
    const doAutoEmbed = opts?.autoEmbed ?? (process.env.MODLENS_BATCH_AUTO_EMBED === "1" || process.env.MODLENS_BATCH_AUTO_EMBED === "true");
    const doAutoGraph = opts?.autoGraph ?? (process.env.MODLENS_BATCH_AUTO_GRAPH === "1" || process.env.MODLENS_BATCH_AUTO_GRAPH === "true");

    function triggerPostDecompile(dbId: number) {
        if (doAutoEmbed) {
            isOllamaAvailable().then(ok => { if (ok) enqueueModEmbed(dbId); }).catch(() => {});
        }
        if (doAutoGraph) {
            ensureGraphify().then(() => { buildModGraph(dbId).catch(() => {}); }).catch(() => {});
        }
    }

    async function processOne(mod: { id: number; modId: string; version: string; jarPath: string | null }) {
        if (!mod.jarPath) { errors++; return; }
        try { assertJarPath(mod.jarPath); } catch { errors++; return; }
        const outDir = paths.decompiled(mod.modId, mod.version);
        const state = await isDecompileDone(outDir);
        if (state === "done") {
            await updateMod(mod.id, { decompiled: true, decompPath: outDir });
            triggerPostDecompile(mod.id);
            alreadyDone++;
            return;
        }
        if (state === "running") { alreadyDone++; return; }
        try {
            await decompileJarJiJ(mod.jarPath, outDir);
            // Wait for Vineflower to finish (up to 15 minutes per mod)
            for (let i = 0; i < 450; i++) {
                await new Promise<void>(r => setTimeout(r, 2000));
                const s = await isDecompileDone(outDir);
                if (s === "done") {
                    await updateMod(mod.id, { decompiled: true, decompPath: outDir });
                    triggerPostDecompile(mod.id);
                    started++;
                    return;
                }
                if (s === "error") { errors++; return; }
            }
            errors++; // timeout
        } catch { errors++; }
    }

    // Run with concurrency — process in batches of N
    for (let i = 0; i < mods.length; i += concurrency) {
        const batch = mods.slice(i, i + concurrency);
        await Promise.all(batch.map(m => processOne(m)));
    }

    return { started, alreadyDone, errors, total: mods.length };
}
