import { db } from "../db.js";
import { parseJar, computeHashes } from "../processor.js";
import { lookupBySha512, getProject as getMrProject } from "../modrinth.js";
import { lookupByFingerprint } from "../curseforge.js";
import { decompileJar } from "../java-tools.js";
import { indexJar } from "../java-tools.js";
import { paths, ensureDir } from "../cache.js";
import { join } from "path";

export async function ingestMod(jarPath: string, skipSource = false) {
    const existing = await db().mod.findUnique({ where: { jarPath } });
    if (existing) return { status: "already_ingested", mod: existing };

    const manifest = await parseJar(jarPath);
    const hashes = await computeHashes(jarPath);

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
            if (!index.classes.length) return;
            await db().modClass.createMany({
                data: index.classes.map((c) => ({
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

export async function decompileMod(dbId: number): Promise<string> {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const outDir = join(paths.decompiled(mod.modId, mod.version));
    await decompileJar(mod.jarPath, outDir);
    await db().mod.update({
        where: { id: dbId },
        data: { decompiled: true, decompPath: outDir },
    });
    return outDir;
}
