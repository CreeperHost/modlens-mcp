import { db } from "../db.js";
import { parseJar, computeHashes } from "../processor.js";
import { lookupBySha512, getProject as getMrProject } from "../modrinth.js";
import { lookupByFingerprint } from "../curseforge.js";
import { decompileJar, isDecompileDone } from "../java-tools.js";
import { indexJar } from "../java-tools.js";
import { paths, ensureDir } from "../cache.js";
import { join } from "path";

export async function ingestMod(jarPath: string, skipSource = false) {
    const existing = await db().mod.findUnique({ where: { jarPath } });
    if (existing) return { status: "already_ingested", mod: existing };

    const manifest = await parseJar(jarPath);
    const hashes = await computeHashes(jarPath);

    // Guard: same modId+version+mcVersion+loader already ingested from a different path
    const duplicate = await db().mod.findFirst({
        where: {
            modId:     manifest.modId,
            version:   manifest.version,
            mcVersion: manifest.mcVersion,
            loader:    manifest.loader,
        },
    });
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
        const bySha = await db().mod.findFirst({ where: { sha512: hashes.sha512 } });
        if (bySha) {
            return {
                status: "duplicate_hash",
                message: `This JAR has the same SHA-512 as already-ingested mod '${bySha.modId}' (db id ${bySha.id}). Files are identical.`,
                existingJarPath: bySha.jarPath,
                existingDbId:    bySha.id,
            };
        }
    }

    const mod = await db().mod.create({
        data: {
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
        },
    });

    if (!skipSource) {
        // Try Modrinth lookup
        try {
            const mrVersion = await lookupBySha512(hashes.sha512);
            if (mrVersion) {
                const mrProject = await getMrProject(mrVersion.project_id);
                await db().mod.update({
                    where: { id: mod.id },
                    data: {
                        modrinthId: mrVersion.project_id,
                        metadata: {
                            ...(mod.metadata as object),
                            modrinthSlug: mrProject?.slug,
                            sourceUrl: mrProject?.source_url ?? manifest.sourceUrl,
                        },
                    },
                });
            }
        } catch { /* non-fatal */ }

        // Try CurseForge lookup
        try {
            const cfProject = await lookupByFingerprint(parseInt(hashes.murmur2));
            if (cfProject) {
                await db().mod.update({
                    where: { id: mod.id },
                    data: {
                        curseforgeId: cfProject.id,
                        metadata: {
                            ...(mod.metadata as object),
                            cfSlug: cfProject.slug,
                            sourceUrl: (mod.metadata as Record<string, string>).sourceUrl ??
                                cfProject.links.sourceUrl,
                        },
                    },
                });
            }
        } catch { /* non-fatal */ }
    }

    // Index classes in background (non-blocking)
    indexJar(jarPath)
        .then(async (index) => {
            const classes = Object.values(index.classes);
            if (!classes.length) return;
            await db().modClass.createMany({
                data: classes.map((c) => ({
                    modId: mod.id,
                    className: c.name,
                    superClass: c.superName || null,
                    interfaces: c.interfaces,
                    accessFlags: c.accessFlags,
                })),
                skipDuplicates: true,
            });
        })
        .catch(() => { /* non-fatal — class index can be retried */ });

    return { status: "ingested", mod: await db().mod.findUnique({ where: { id: mod.id } }) };
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
    const mods = dbId
        ? await db().mod.findMany({ where: { id: dbId } })
        : await db().mod.findMany();

    let indexed = 0, failed = 0, skipped = 0;

    for (const mod of mods) {
        const existing = await db().modClass.count({ where: { modId: mod.id } });
        if (existing > 0) { skipped++; continue; }
        try {
            const index = await indexJar(mod.jarPath);
            const classes = Object.values(index.classes);
            if (!classes.length) { skipped++; continue; }
            await db().modClass.createMany({
                data: classes.map((c) => ({
                    modId: mod.id,
                    className: c.name,
                    superClass: c.superName || null,
                    interfaces: c.interfaces,
                    accessFlags: c.accessFlags,
                })),
                skipDuplicates: true,
            });
            indexed++;
        } catch {
            failed++;
        }
    }

    return { indexed, failed, skipped };
}

export async function decompileMod(dbId: number): Promise<{ status: string; outDir: string; message: string }> {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const outDir = join(paths.decompiled(mod.modId, mod.version));

    // Check if already done
    const state = await isDecompileDone(outDir);
    if (state === "done") {
        await db().mod.update({ where: { id: dbId }, data: { decompiled: true, decompPath: outDir } });
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
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const outDir = join(paths.decompiled(mod.modId, mod.version));
    const state = await isDecompileDone(outDir);

    if (state === "done") {
        // Mark DB as done if not already
        if (!mod.decompiled) {
            await db().mod.update({ where: { id: dbId }, data: { decompiled: true, decompPath: outDir } });
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
