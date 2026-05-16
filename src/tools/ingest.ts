import { parseJar, computeHashes } from "../processor.js";
import { lookupBySha512, getProject as getMrProject } from "../modrinth.js";
import { lookupByFingerprint } from "../curseforge.js";
import { decompileJar, isDecompileDone } from "../java-tools.js";
import { indexJar } from "../java-tools.js";
import { paths, ensureDir } from "../cache.js";
import { join } from "path";
import {
    findModByJarPath, findModByDupKey, findModBySha512,
    createMod, updateMod, findModById, listAllMods,
    countModClasses, createModClasses,
} from "../repositories/mod.js";
import { validateDbId } from "../validate.js";

// ── IngestResult discriminated union ─────────────────────────────────────────

export type IngestResult =
    | { status: "already_ingested";  mod: Awaited<ReturnType<typeof findModById>> }
    | { status: "duplicate_version"; message: string; existingJarPath: string; existingDbId: number }
    | { status: "duplicate_hash";    message: string; existingJarPath: string; existingDbId: number }
    | { status: "ingested";          mod: Awaited<ReturnType<typeof findModById>> };

// ── Platform lookup result types ─────────────────────────────────────────────

type MrLookupOk  = { platform: "modrinth";   projectId: string; slug?: string; sourceUrl?: string | null };
type CfLookupOk  = { platform: "curseforge"; projectId: number; slug?: string; sourceUrl?: string };
type PlatformHit = MrLookupOk | CfLookupOk;

async function lookupPlatforms(
    sha512: string | null,
    murmur2: string | null,
): Promise<PlatformHit[]> {
    const tasks: Promise<PlatformHit | null>[] = [];

    if (sha512) {
        tasks.push(
            lookupBySha512(sha512)
                .then(async (ver) => {
                    if (!ver) return null;
                    const proj = await getMrProject(ver.project_id).catch(() => null);
                    return {
                        platform: "modrinth" as const,
                        projectId: ver.project_id,
                        slug: proj?.slug,
                        sourceUrl: proj?.source_url,
                    };
                })
                .catch(() => null),
        );
    }

    if (murmur2) {
        const m = parseInt(murmur2, 10);
        if (!isNaN(m)) {
            tasks.push(
                lookupByFingerprint(m)
                    .then((proj) => {
                        if (!proj) return null;
                        return {
                            platform: "curseforge" as const,
                            projectId: proj.id,
                            slug: proj.slug,
                            sourceUrl: proj.links?.sourceUrl,
                        };
                    })
                    .catch(() => null),
            );
        }
    }

    const results = await Promise.allSettled(tasks);
    return results
        .filter((r): r is PromiseFulfilledResult<PlatformHit | null> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((v): v is PlatformHit => v !== null);
}

// ── Main ingest ───────────────────────────────────────────────────────────────

export async function ingestMod(jarPath: string, skipSource = false): Promise<IngestResult> {
    const existing = await findModByJarPath(jarPath);
    if (existing) return { status: "already_ingested", mod: existing };

    const manifest = await parseJar(jarPath);
    const hashes = await computeHashes(jarPath);

    // Guard: same modId+version+mcVersion+loader already ingested from a different path
    const duplicate = await findModByDupKey(
        manifest.modId, manifest.version, manifest.mcVersion, manifest.loader
    );
    if (duplicate) {
        return {
            status: "duplicate_version",
            message: `${manifest.modId} ${manifest.version} (${manifest.loader} / ${manifest.mcVersion}) is already ingested from a different path.`,
            existingJarPath: duplicate.jarPath,
            existingDbId:    duplicate.id,
        };
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
): Promise<object> {
    const { readdir } = await import("fs/promises");
    const { join, resolve } = await import("path");

    const absDir = resolve(directory);
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
            const result = await ingestMod(jarPath, skipSource);
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
    await decompileJar(mod.jarPath, outDir);

    return {
        status: "started",
        outDir,
        message: "Vineflower launched in background. Call decompile_mod_status with the same dbId to check progress. This avoids MCP timeout.",
    };
}

export async function decompileModStatus(dbId: number): Promise<{ status: string; outDir: string; message: string }> {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const outDir = join(paths.decompiled(mod.modId, mod.version));
    const state = await isDecompileDone(outDir);

    if (state === "done") {
        // Mark DB as done if not already
        if (!mod.decompiled) {
        await updateMod(dbId, { decompiled: true, decompPath: outDir });
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
