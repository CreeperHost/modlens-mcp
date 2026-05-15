import { db } from "../db.js";
import { lookupBySha512, getProject as getMrProject, getLatestVersion as getMrLatest } from "../modrinth.js";
import { lookupByFingerprint, getLatestFile as getCfLatest } from "../curseforge.js";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { ensureDir } from "../cache.js";

export async function syncModrinth(dbId: number) {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    if (!mod.sha512) throw new Error("Mod has no SHA-512 hash — re-ingest to compute it");

    const version = await lookupBySha512(mod.sha512);
    if (!version) return { matched: false };

    const project = await getMrProject(version.project_id);
    await db().mod.update({
        where: { id: dbId },
        data: {
            modrinthId: version.project_id,
            metadata: {
                ...(mod.metadata as object),
                modrinthSlug: project?.slug,
                sourceUrl: (mod.metadata as Record<string, string>).sourceUrl ?? project?.source_url,
            },
        },
    });

    return { matched: true, projectId: version.project_id, slug: project?.slug, sourceUrl: project?.source_url };
}

export async function syncCurseforge(dbId: number) {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    if (!mod.murmur2) throw new Error("Mod has no Murmur2 hash — re-ingest to compute it");

    const project = await lookupByFingerprint(parseInt(mod.murmur2));
    if (!project) return { matched: false };

    await db().mod.update({
        where: { id: dbId },
        data: {
            curseforgeId: project.id,
            metadata: {
                ...(mod.metadata as object),
                cfSlug: project.slug,
                sourceUrl: (mod.metadata as Record<string, string>).sourceUrl ?? project.links.sourceUrl,
            },
        },
    });

    return { matched: true, projectId: project.id, slug: project.slug, sourceUrl: project.links.sourceUrl };
}

export async function checkUpdates(dbId: number) {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const results: Record<string, unknown> = {};

    if (mod.modrinthId) {
        try {
            const latest = await getMrLatest(mod.modrinthId, mod.mcVersion || undefined);
            if (latest) {
                results.modrinth = {
                    latestVersion: latest.version_number,
                    currentVersion: mod.version,
                    isLatest: latest.version_number === mod.version,
                    releaseDate: latest.date_published,
                    downloadUrl: latest.files.find((f) => f.primary)?.url,
                };
            }
        } catch { results.modrinth = { error: "lookup failed" }; }
    }

    if (mod.curseforgeId) {
        try {
            const latest = await getCfLatest(mod.curseforgeId, mod.mcVersion || undefined);
            if (latest) {
                results.curseforge = {
                    latestFile: latest.displayName,
                    releaseDate: latest.fileDate,
                    gameVersions: latest.gameVersions,
                    downloadUrl: latest.downloadUrl,
                };
            }
        } catch { results.curseforge = { error: "lookup failed" }; }
    }

    if (!results.modrinth && !results.curseforge) {
        return { checked: false, reason: "Mod not linked to Modrinth or CurseForge. Run sync_modrinth or sync_curseforge first." };
    }

    return { checked: true, currentVersion: mod.version, ...results };
}

export async function downloadSource(dbId: number): Promise<string> {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const meta = mod.metadata as Record<string, string>;
    const sourceUrl = meta.sourceUrl;
    if (!sourceUrl) throw new Error("No source URL found. Run sync_modrinth or sync_curseforge first.");

    // Convert GitHub repo URL to ZIP download
    const zipUrl = sourceUrl.replace("github.com", "codeload.github.com")
        .replace(/\/?$/, "/zip/refs/heads/main");

    const outDir = `${process.env.HOME ?? process.env.USERPROFILE}/.modlens-cache/sources/${mod.modId}/${mod.version}`;
    const zipPath = outDir + ".zip";
    await ensureDir(zipPath);

    const res = await fetch(zipUrl);
    if (!res.ok) {
        // Try master branch
        const res2 = await fetch(zipUrl.replace("/main", "/master"));
        if (!res2.ok) throw new Error(`Failed to download source from ${sourceUrl}`);
        const writer = createWriteStream(zipPath);
        await pipeline(res2.body as unknown as NodeJS.ReadableStream, writer);
    } else {
        const writer = createWriteStream(zipPath);
        await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
    }

    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(outDir, true);

    await db().mod.update({ where: { id: dbId }, data: { sourcePath: outDir } });
    return outDir;
}

/**
 * Batch sync Modrinth + CurseForge metadata for all mods that haven't been
 * looked up yet, then optionally download actual GitHub source ZIPs.
 *
 * Phases (all optional via flags):
 *   syncModrinth   — SHA-512 lookup on Modrinth  (default true)
 *   syncCurseforge — Murmur2 lookup on CurseForge (default true)
 *   downloadSources — download GitHub source ZIPs for matched mods (default false)
 */
export async function batchSyncSources(opts: {
    syncModrinth?: boolean;
    syncCurseforge?: boolean;
    downloadSources?: boolean;
    modIdFilter?: string;
    limit?: number;
} = {}): Promise<object> {
    const {
        syncModrinth: doMR = true,
        syncCurseforge: doCF = true,
        downloadSources: doGH = false,
        modIdFilter,
        limit = 500,
    } = opts;

    const mods = await db().mod.findMany({
        where: {
            ...(modIdFilter ? { modId: { contains: modIdFilter } } : {}),
        },
        select: { id: true, modId: true, version: true, sha512: true, murmur2: true,
                  modrinthId: true, curseforgeId: true, sourcePath: true, metadata: true },
        orderBy: { id: "asc" },
        take: limit,
    });

    let mrMatched = 0, mrSkipped = 0, mrFailed = 0;
    let cfMatched = 0, cfSkipped = 0, cfFailed = 0;
    let ghDownloaded = 0, ghFailed = 0;
    const results: Array<{ modId: string; version: string; modrinth?: string; curseforge?: string; source?: string; error?: string }> = [];

    for (const mod of mods) {
        const row: (typeof results)[0] = { modId: mod.modId, version: mod.version };

        // ── Modrinth ──────────────────────────────────────────────────────────
        if (doMR && !mod.modrinthId && mod.sha512) {
            try {
                const r = await syncModrinth(mod.id);
                if (r.matched) { mrMatched++; row.modrinth = `matched: ${r.slug}`; }
                else { mrSkipped++; }
            } catch (e) {
                mrFailed++;
                row.error = `MR: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`;
            }
        } else if (doMR && mod.modrinthId) {
            mrSkipped++;
        }

        // ── CurseForge ────────────────────────────────────────────────────────
        if (doCF && !mod.curseforgeId && mod.murmur2) {
            try {
                const r = await syncCurseforge(mod.id);
                if (r.matched) { cfMatched++; row.curseforge = `matched: ${r.slug}`; }
                else { cfSkipped++; }
            } catch (e) {
                cfFailed++;
                row.error = (row.error ? row.error + " | " : "") +
                    `CF: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`;
            }
        } else if (doCF && mod.curseforgeId) {
            cfSkipped++;
        }

        // ── GitHub source download ─────────────────────────────────────────────
        if (doGH && !mod.sourcePath) {
            // Re-read metadata after potential sync above
            const fresh = await db().mod.findUnique({ where: { id: mod.id }, select: { metadata: true } });
            const sourceUrl = (fresh?.metadata as Record<string, string>)?.sourceUrl;
            if (sourceUrl) {
                try {
                    const outDir = await downloadSource(mod.id);
                    ghDownloaded++;
                    row.source = `downloaded: ${outDir}`;
                } catch (e) {
                    ghFailed++;
                    row.error = (row.error ? row.error + " | " : "") +
                        `GH: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`;
                }
            }
        }

        if (row.modrinth || row.curseforge || row.source || row.error) {
            results.push(row);
        }
    }

    return {
        total: mods.length,
        modrinth:   doMR ? { matched: mrMatched, skipped: mrSkipped, failed: mrFailed } : "skipped",
        curseforge: doCF ? { matched: cfMatched, skipped: cfSkipped, failed: cfFailed } : "skipped",
        github:     doGH ? { downloaded: ghDownloaded, failed: ghFailed } : "skipped",
        results,
    };
}
