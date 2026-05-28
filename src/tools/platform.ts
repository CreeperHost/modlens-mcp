import { lookupBySha512, getProject as getMrProject, getLatestVersion as getMrLatest } from "../modrinth.js";
import { lookupByFingerprint, getLatestFile as getCfLatest } from "../curseforge.js";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { ensureDir } from "../cache.js";
import { findModById, updateMod, listModsForSync, getModMetadata } from "../repositories/mod.js";
import { fileSha512, verifyFileHash, HashMismatchError, validatePath } from "../security.js";
import { buildModGraph, ensureGraphify } from "./graphify.js";
import type { AutoBehaviorOpts } from "./ingest.js";

/** Resolve an auto-behavior flag: explicit param > env var > default (true). */
function resolveAuto(explicit: boolean | undefined, envKey: string): boolean {
    if (explicit !== undefined) return explicit;
    const envVal = process.env[envKey];
    if (envVal === "0" || envVal === "false") return false;
    return true;
}

export async function syncModrinth(dbId: number) {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    if (!mod.sha512) throw new Error("Mod has no SHA-512 hash — re-ingest to compute it");

    const version = await lookupBySha512(mod.sha512);
    if (!version) return { matched: false };

    const project = await getMrProject(version.project_id);
    await updateMod(dbId, {
        modrinthId: version.project_id,
        metadata: {
            ...(mod.metadata as object),
            modrinthSlug: project?.slug,
            sourceUrl: (mod.metadata as Record<string, string>).sourceUrl ?? project?.source_url,
        },
    });

    return { matched: true, projectId: version.project_id, slug: project?.slug, sourceUrl: project?.source_url };
}

export async function syncCurseforge(dbId: number) {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    if (!mod.murmur2) throw new Error("Mod has no Murmur2 hash — re-ingest to compute it");

    const project = await lookupByFingerprint(parseInt(mod.murmur2));
    if (!project) return { matched: false };

    await updateMod(dbId, {
        curseforgeId: project.id,
        metadata: {
            ...(mod.metadata as object),
            cfSlug: project.slug,
            sourceUrl: (mod.metadata as Record<string, string>).sourceUrl ?? project.links.sourceUrl,
        },
    });

    return { matched: true, projectId: project.id, slug: project.slug, sourceUrl: project.links.sourceUrl };
}

export async function checkUpdates(dbId: number) {
    const mod = await findModById(dbId);
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

export async function downloadSource(dbId: number, opts?: AutoBehaviorOpts): Promise<string> {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const meta = mod.metadata as Record<string, string>;
    const sourceUrl = meta.sourceUrl;
    if (!sourceUrl) throw new Error("No source URL found. Run sync_modrinth or sync_curseforge first.");

    // ── URL validation ─────────────────────────────────────────────────────
    let parsed: URL;
    try { parsed = new URL(sourceUrl); } catch { throw new Error(`Invalid source URL: ${sourceUrl}`); }
    if (parsed.protocol !== "https:") throw new Error(`Source URL must use HTTPS: ${sourceUrl}`);
    const ALLOWED_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];
    if (!ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
        throw new Error(`Source URL hostname not allowed: ${parsed.hostname} (expected: ${ALLOWED_HOSTS.join(", ")})`);
    }

    // ── Path sanitization ──────────────────────────────────────────────────
    const safeModId = mod.modId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeVersion = mod.version.replace(/[^a-zA-Z0-9._-]/g, "_");
    const cacheRoot = `${process.env.HOME ?? process.env.USERPROFILE}/.modlens-cache/sources`;
    const outDir = `${cacheRoot}/${safeModId}/${safeVersion}`;
    const tmpZip = outDir + ".tmp.zip";
    const zipPath = outDir + ".zip";
    validatePath(outDir, cacheRoot);
    await ensureDir(tmpZip);

    // ── Download to temp file ──────────────────────────────────────────────
    // Convert GitHub repo URL to ZIP download
    const zipUrl = sourceUrl.replace("github.com", "codeload.github.com")
        .replace(/\/?$/, "/zip/refs/heads/main");

    try {
        const res = await fetch(zipUrl);
        if (!res.ok) {
            // Try master branch
            const res2 = await fetch(zipUrl.replace("/main", "/master"));
            if (!res2.ok) throw new Error(`Failed to download source from ${sourceUrl}`);
            const writer = createWriteStream(tmpZip);
            await pipeline(res2.body as unknown as NodeJS.ReadableStream, writer);
        } else {
            const writer = createWriteStream(tmpZip);
            await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
        }
    } catch (e) {
        // Clean up partial temp file on any download failure
        await import("fs/promises").then(f => f.unlink(tmpZip).catch(() => {}));
        throw e;
    }

    // Atomic rename: temp → final zip
    const { rename, unlink } = await import("fs/promises");
    await rename(tmpZip, zipPath);

    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(zipPath);

    // ── Integrity check ────────────────────────────────────────────────────
    const metaObj = mod.metadata as Record<string, unknown>;
    const expectedSha512 = metaObj.modrinthFileSha512 as string | undefined;

    if (expectedSha512) {
        try {
            await verifyFileHash(zipPath, expectedSha512);
        } catch (e) {
            if (e instanceof HashMismatchError) {
                await unlink(zipPath).catch(() => {});
                throw new Error(`Source ZIP integrity check FAILED for mod #${dbId}: ${e.message}`);
            }
            throw e;
        }
    } else {
        const actualSha = await fileSha512(zipPath);
        await updateMod(dbId, {
            metadata: { ...(mod.metadata as object), sourceZipSha256: actualSha } as Parameters<typeof updateMod>[1]["metadata"],
        });
    }

    try {
        zip.extractAllTo(outDir, true);
    } catch (e) {
        // Clean up partial extraction + zip on failure
        const { rm } = await import("fs/promises");
        await rm(outDir, { recursive: true, force: true }).catch(() => {});
        await unlink(zipPath).catch(() => {});
        throw new Error(`Failed to extract source ZIP for mod #${dbId}: ${e instanceof Error ? e.message : String(e)}`);
    }

    await updateMod(dbId, { sourcePath: outDir });

    // Fire-and-forget: auto-build knowledge graph from downloaded source
    if (resolveAuto(opts?.autoGraph, "MODLENS_AUTO_GRAPH")) {
        ensureGraphify().then(() => {
            buildModGraph(dbId).catch(() => {});
        }).catch(() => {});
    }

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

    const mods = await listModsForSync({ modIdFilter, limit });

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
            const fresh = await getModMetadata(mod.id);
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
