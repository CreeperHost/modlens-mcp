/**
 * modpacks.ch tool — search and sync packs from both the FTB and
 * CurseForge namespaces exposed by the modpacks.ch public API (no API key
 * required for either).
 *
 * modpacks.ch is a service by CreeperHost (https://www.creeperhost.net).
 * Thanks to CreeperHost for providing this free public API.
 *
 * User-Agent spec: The modpacks.ch team requested a custom User-Agent for
 * usage tracking.  See USER_AGENT constant in src/modpacks-ch.ts.
 *
 * Supported actions:
 *   search          — full-text search FTB or CurseForge packs
 *   featured        — list featured FTB packs
 *   info            — get pack metadata + version list
 *   manifest        — get the full file manifest for a specific version
 *   sync_pack_mods  — download + ingest every mod/datapack/resourcepack JAR
 *                     from a pack version's manifest into the ModLens DB
 *   search_ftb_mods — search the FTB mod index (returns mixed CF int / MR
 *                     string IDs)
 */
import { join, resolve } from "path";
import { createHash } from "crypto";
import { rename, mkdir } from "fs/promises";
import AdmZip from "adm-zip";
import { ensureDir, exists, CACHE_ROOT } from "../cache.js";
import {
    searchPacks, getFeaturedPacks, getPack, getPackManifest,
    getCfPack, getCfPackManifest,
    searchMods, getMod, getModsBatch, resolveModVersionUrl,
    USER_AGENT, cfCdnUrl,
    downloadManifestFile, resolveFileUrl,
    type FtbManifest, type FtbManifestFile, type FtbModVersion,
} from "../modpacks-ch.js";
import { fetchWithRetry, DOWNLOAD_OPTS } from "../fetch-utils.js";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

const MOD_HEADERS = { "User-Agent": USER_AGENT };
import { ingestMod } from "./ingest.js";
import {
    upsertPackVersion, upsertPackFile,
    listPackVersions, listPackFiles,
    findPacksForMod, findPacksForCfProject, findPackVersion,
} from "../repositories/packs.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type PackNamespace = "ftb" | "curseforge";

export interface SyncPackModsOptions {
    packId:      number;
    versionId:   number;
    namespace:   PackNamespace;
    /** Only ingest files matching these types (default: ["mod", "resource"]). */
    fileTypes?:  string[];
    /** Skip files that are server-only (default: false). */
    skipServer?: boolean;
    /** Skip optional files (default: false). */
    skipOptional?: boolean;
    /** Maximum number of mods to ingest concurrently (default: 3). */
    concurrency?: number;
}

interface FileResult {
    name:      string;
    type:      string;
    fileId?:   number;  // manifest file id (file.id from modpacks.ch API)
    status:    string;
    dbId?:     number;
    message?:  string;
}

// ── Pack search / browse ──────────────────────────────────────────────────────

export async function searchPacksAction(term: string, namespace: PackNamespace = "ftb", limit = 20) {
    // Always call the unified FTB search endpoint — it returns both FTB pack IDs
    // (in `packs`) and CurseForge pack IDs (in `curseforge`) in a single response.
    // The /curseforge/search/ endpoint does not exist.
    const r = await searchPacks(term, limit);
    if (!r) return { ftbPacks: [], cfPacks: [], total: 0 };
    const ftbPacks = r.packs        ?? [];
    const cfPacks  = r.curseforge   ?? [];
    // If caller specified a namespace, surface only that subset (but always
    // include both for discoverability — callers can filter as needed).
    return {
        ftbPacks,
        cfPacks,
        total:   r.total,
        note:    "ftbPacks = FTB-hosted; cfPacks = CurseForge-hosted (use namespace=curseforge for info/manifest)",
    };
}

export async function featuredPacksAction(limit = 20) {
    const r = await getFeaturedPacks(limit);
    if (!r) return { packs: [], total: 0 };
    return r;
}

export async function packInfoAction(packId: number, namespace: PackNamespace = "ftb") {
    const pack = namespace === "curseforge"
        ? await getCfPack(packId)
        : await getPack(packId);
    if (!pack) throw new Error(`Pack ${packId} not found on namespace "${namespace}"`);

    // Summarise versions (strip massive description field)
    return {
        id:       pack.id,
        name:     pack.name,
        synopsis: pack.synopsis,
        provider: pack.provider,
        installs: pack.installs,
        tags:     (pack.tags ?? []).map((t) => t.name),
        authors:  (pack.authors ?? []).map((a) => ({ name: a.name, type: a.type })),
        links:    (pack.links ?? []).map((l) => ({ type: l.type, url: l.link })),
        versions: (pack.versions ?? []).map((v) => ({
            id:      v.id,
            name:    v.name,
            type:    v.type,
            targets: (v.targets ?? []).map((t) => ({ name: t.name, version: t.version })),
            updated: new Date(v.updated * 1000).toISOString(),
        })),
    };
}

export async function packManifestAction(packId: number, versionId: number, namespace: PackNamespace = "ftb") {
    const manifest = namespace === "curseforge"
        ? await getCfPackManifest(packId, versionId)
        : await getPackManifest(packId, versionId);
    if (!manifest) throw new Error(`Manifest not found for pack ${packId} version ${versionId} (${namespace})`);

    const fileSummary = (f: FtbManifestFile) => ({
        id:         f.id,
        name:       f.name,
        type:       f.type,
        path:       f.path,
        size:       f.size,
        sha1:       f.sha1 || null,
        clientonly: f.clientonly,
        serveronly: f.serveronly,
        optional:   f.optional,
        hasCdnUrl:  !!resolveFileUrl(f),
        cfProject:  f.curseforge?.project ?? null,
        cfFile:     f.curseforge?.file    ?? null,
    });

    const manifestFiles = manifest.files ?? [];
    return {
        id:        manifest.id,
        parent:    manifest.parent,
        name:      manifest.name,
        version:   manifest.version,
        type:      manifest.type,
        targets:   (manifest.targets ?? []).map((t) => ({ name: t.name, version: t.version })),
        fileCount: manifestFiles.length,
        byType:    Object.fromEntries(
            [...new Set(manifestFiles.map((f) => f.type))].map((t) => [
                t,
                manifestFiles.filter((f) => f.type === t).length,
            ]),
        ),
        files: manifestFiles.map(fileSummary),
    };
}

// ── FTB mod search ────────────────────────────────────────────────────────────

export async function searchFtbModsAction(term: string, limit = 20) {
    const r = await searchMods(term, limit);
    if (!r) return { mods: [], total: 0, enriched: [] };
    // Enrich the first up to 20 IDs into full mod objects so callers get
    // names/synopses without having to call ftb_mod_info for each hit.
    const mods = r.mods ?? [];
    const take = mods.slice(0, Math.min(mods.length, 20));
    const enriched = await getModsBatch(take);
    return {
        total: r.total ?? 0,
        mods,
        enriched: enriched.map((m) => ({
            id:       m.id,
            name:     m.name,
            synopsis: m.synopsis,
            installs: m.installs,
            links:    (m.links ?? []).map((l) => ({ type: l.type, url: l.link })),
        })),
    };
}

export async function ftbModInfoAction(modId: number | string, opts: {
    mcVersion?: string; loader?: string;
} = {}) {
    const m = await getMod(modId);
    if (!m) throw new Error(`FTB mod ${modId} not found`);

    // Filter versions by mcVersion / loader if requested
    let versions = m.versions as FtbModVersion[];
    if (opts.mcVersion) {
        versions = versions.filter((v) =>
            v.targets.some((t) => t.type === "game" && t.version === opts.mcVersion)
        );
    }
    if (opts.loader) {
        const loaderLower = opts.loader.toLowerCase();
        versions = versions.filter((v) =>
            v.targets.some((t) => t.type === "modloader" && t.name.toLowerCase() === loaderLower)
        );
    }

    return {
        id:       m.id,
        name:     m.name,
        synopsis: m.synopsis,
        installs: m.installs,
        links:    m.links.map((l) => ({ type: l.type, url: l.link })),
        versions: versions.map((v) => ({
            fileId:  v.id,
            name:    v.name,
            version: v.version,
            type:    v.type,
            size:    v.size,
            sha1:    v.sha1 || null,
            url:     resolveModVersionUrl(v),
            mcVersions: v.targets.filter((t) => t.type === "game").map((t) => t.version),
            loaders:    v.targets.filter((t) => t.type === "modloader").map((t) => t.name),
            updated: new Date(v.updated * 1000).toISOString(),
        })),
    };
}

/**
 * Download and ingest a single mod JAR from the modpacks.ch CDN.
 * No CF API key required.
 *
 * @param modId    - CF project ID (integer) or Modrinth slug/ID (string)
 * @param opts.mcVersion - Filter to versions for this MC version
 * @param opts.loader    - Filter to versions for this loader (neoforge, fabric, etc.)
 * @param opts.fileId    - Exact CF file ID to download (skip filtering)
 * @param opts.force     - Re-download even if the file is already in cache
 */
export async function downloadModAction(modId: number | string, opts: {
    mcVersion?: string; loader?: string; fileId?: number; force?: boolean;
} = {}): Promise<{
    status: string;
    modId?: number;
    name?: string;
    version?: string;
    jarPath?: string;
    message?: string;
}> {
    const m = await getMod(modId);
    if (!m) throw new Error(`Mod ${modId} not found on modpacks.ch`);

    let candidates = m.versions as FtbModVersion[];

    if (opts.fileId !== undefined) {
        // Exact file requested
        candidates = candidates.filter((v) => v.id === opts.fileId);
    } else {
        if (opts.mcVersion) {
            candidates = candidates.filter((v) =>
                v.targets.some((t) => t.type === "game" && t.version === opts.mcVersion)
            );
        }
        if (opts.loader) {
            const lo = opts.loader.toLowerCase();
            candidates = candidates.filter((v) =>
                v.targets.some((t) => t.type === "modloader" && t.name.toLowerCase() === lo)
            );
        }
    }

    if (candidates.length === 0) {
        throw new Error(
            `No version of mod ${m.name} (${modId}) matches the requested filters` +
            (opts.mcVersion ? ` mcVersion=${opts.mcVersion}` : "") +
            (opts.loader    ? ` loader=${opts.loader}`       : "")
        );
    }

    // Take the first (most recent) matching version
    const version = candidates[0];
    const url = resolveModVersionUrl(version);
    if (!url) throw new Error(`No download URL available for ${version.name}`);

    // Build a stable cache path: use sha1 when available
    const key      = version.sha1 || String(version.id);
    const destPath = join(CACHE_ROOT, "mods", String(m.id), `${key}.jar`);
    const tmpPath  = destPath + ".tmp";

    await ensureDir(destPath);

    if (opts.force || !(await exists(destPath))) {
        const res = await fetchWithRetry(url, { headers: MOD_HEADERS }, DOWNLOAD_OPTS);
        if (!res.ok) throw new Error(`Download failed for ${version.name}: HTTP ${res.status}`);
        const stream = createWriteStream(tmpPath);
        await pipeline(res.body as unknown as NodeJS.ReadableStream, stream);
        await rename(tmpPath, destPath);
    }

    const result = await ingestMod(destPath, /* skipSource */ true);
    return {
        status:  result.status,
        modId:   result.status === "ingested" || result.status === "replaced" || result.status === "already_ingested"
                     ? (result.mod?.id ?? (result as { existingDbId?: number }).existingDbId)
                     : undefined,
        name:    version.name,
        version: version.version,
        jarPath: destPath,
        message: "message" in result ? result.message : undefined,
    };
}

// ── Sync pack mods ────────────────────────────────────────────────────────────

/**
 * Download and ingest every mod (and optionally resource/datapack) from a
 * modpack manifest into the ModLens database.
 *
 * Works for both FTB packs and CurseForge packs via the modpacks.ch API —
 * no CurseForge API key required.
 */
export async function syncPackModsAction(opts: SyncPackModsOptions): Promise<{
    packId:          number;
    versionId:       number;
    namespace:       string;
    packVersionDbId: number;
    total:           number;
    ingested:        number;
    skipped:         number;
    failed:          number;
    files:           FileResult[];
}> {
    const { packId, versionId, namespace, concurrency = 3 } = opts;
    const ingestTypes  = opts.fileTypes   ?? ["mod", "resource"];
    const skipServer   = opts.skipServer  ?? false;
    const skipOptional = opts.skipOptional ?? false;

    const manifest: FtbManifest | null = namespace === "curseforge"
        ? await getCfPackManifest(packId, versionId)
        : await getPackManifest(packId, versionId);

    if (!manifest) {
        throw new Error(`Manifest not found for pack ${packId} v${versionId} (${namespace})`);
    }

    // Filter to downloadable, ingestable file types
    const candidates = manifest.files.filter((f) => {
        if (!ingestTypes.includes(f.type)) return false;
        if (skipServer   && f.serveronly)  return false;
        if (skipOptional && f.optional)    return false;
        if (!resolveFileUrl(f))            return false;  // no URL → skip
        return true;
    });

    const packCacheDir = join(CACHE_ROOT, "packs", String(namespace), String(packId), String(versionId));
    const results: FileResult[] = [];

    // Process `concurrency` files at a time
    for (let i = 0; i < candidates.length; i += concurrency) {
        const batch = candidates.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map((file) => processFile(file, packCacheDir)));
        results.push(...batchResults);
    }

    // ── Record pack membership ────────────────────────────────────────────────
    // Upsert the pack version row first.
    const mcVersion  = manifest.targets.find((t) => t.name === "minecraft")?.version ?? null;
    const modloader  = manifest.targets.find((t) => t.type === "modloader")?.name    ?? null;
    const pvId = await upsertPackVersion({
        namespace,
        packId,
        versionId,
        packName:    manifest.name,
        versionName: manifest.version || manifest.name,
        mcVersion,
        modloader,
    });

    // Build a map from manifest file id → processed result.
    const resultMap = new Map<number, FileResult>();
    for (const r of results) {
        if (r.fileId !== undefined) resultMap.set(r.fileId, r);
    }

    // Upsert one PackFile row per manifest entry (ALL files, not just candidates).
    await Promise.all(manifest.files.map((f) => {
        const processed = resultMap.get(f.id);
        return upsertPackFile({
            packVersionId:   pvId,
            manifestFileId:  f.id,
            fileType:        f.type,
            fileName:        f.name,
            filePath:        f.path  || null,
            cfProject:       f.curseforge?.project ?? null,
            cfFile:          f.curseforge?.file    ?? null,
            sha1:            f.sha1 || null,
            status:          processed?.status ?? "not_synced",
            modId:           processed?.dbId   ?? null,
        });
    }));

    const ingested = results.filter((r) => r.status === "ingested" || r.status === "replaced").length;
    const skipped  = results.filter((r) => r.status === "already_ingested" || r.status === "duplicate_version" || r.status === "duplicate_hash").length;
    const failed   = results.filter((r) => r.status === "error").length;

    return {
        packId,
        versionId,
        namespace,
        packVersionDbId: pvId,
        total:    candidates.length,
        ingested,
        skipped,
        failed,
        files:    results,
    };
}

async function processFile(file: FtbManifestFile, cacheDir: string): Promise<FileResult> {
    const url = resolveFileUrl(file)!;
    // Derive a stable local path: sha1 preferred, fall back to name hash
    const key     = file.sha1 || createHash("sha1").update(url).digest("hex");
    const ext     = file.name.endsWith(".zip") ? ".zip" : ".jar";
    const destPath = join(cacheDir, `${key}${ext}`);

    try {
        await ensureDir(destPath);

        if (!(await exists(destPath))) {
            // Download to a temp path then rename atomically
            const tmpPath = destPath + ".tmp";
            await downloadManifestFile(file, tmpPath);
            await rename(tmpPath, destPath);
        }

        // Only ingest JARs (mods) — ZIPs are resource/datapacks that the
        // ingestMod path doesn't handle yet.
        if (ext === ".zip") {
            return { name: file.name, type: file.type, fileId: file.id, status: "downloaded_zip" };
        }

        const result = await ingestMod(destPath, /* skipSource */ true);
        return {
            name:    file.name,
            type:    file.type,
            fileId:  file.id,
            status:  result.status,
            dbId:    result.status === "ingested" || result.status === "replaced"
                        ? result.mod?.id
                        : result.status === "already_ingested"
                            ? result.mod?.id
                            : (result as { existingDbId?: number }).existingDbId,
            message: "message" in result ? result.message : undefined,
        };
    } catch (err) {
        return {
            name:    file.name,
            type:    file.type,
            fileId:  file.id,
            status:  "error",
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

// ── Pack membership queries ───────────────────────────────────────────────────

/** List all pack versions recorded in the DB, optionally filtered by namespace / packId. */
export async function listPackVersionsAction(namespace?: string, packId?: number) {
    const rows = await listPackVersions(namespace, packId);
    return {
        total: rows.length,
        versions: rows.map((v) => ({
            dbId:        v.id,
            namespace:   v.namespace,
            packId:      v.packId,
            versionId:   v.versionId,
            packName:    v.packName,
            versionName: v.versionName,
            mcVersion:   v.mcVersion,
            modloader:   v.modloader,
            syncedAt:    v.syncedAt,
        })),
    };
}

/**
 * List all files recorded for a specific pack version.
 * Look up the version by either its DB id (packVersionDbId) or
 * the (namespace + packId + versionId) triple.
 */
export async function listPackFilesAction(opts: {
    packVersionDbId?: number;
    namespace?: string;
    packId?: number;
    versionId?: number;
    fileType?: string;
}) {
    let pvId = opts.packVersionDbId;
    if (pvId === undefined) {
        if (!opts.namespace || opts.packId === undefined || opts.versionId === undefined) {
            throw new Error("Provide either packVersionDbId or (namespace + packId + versionId)");
        }
        const pv = await findPackVersion(opts.namespace, opts.packId, opts.versionId);
        if (!pv) throw new Error(`Pack version not yet recorded — run sync_pack_mods first`);
        pvId = pv.id;
    }
    const files = await listPackFiles(pvId);
    const filtered = opts.fileType ? files.filter((f) => f.fileType === opts.fileType) : files;
    return {
        packVersionDbId: pvId,
        total:   filtered.length,
        byType:  Object.fromEntries(
            [...new Set(files.map((f) => f.fileType))].map((t) => [
                t,
                files.filter((f) => f.fileType === t).length,
            ]),
        ),
        files: filtered.map((f) => ({
            id:             f.id,
            manifestFileId: f.manifestFileId,
            fileType:       f.fileType,
            fileName:       f.fileName,
            filePath:       f.filePath,
            cfProject:      f.cfProject,
            cfFile:         f.cfFile,
            sha1:           f.sha1,
            status:         f.status,
            modId:          f.modId,
        })),
    };
}

/**
 * Find every pack version that contains a given mod.
 * Accepts a ModLens DB mod id (modDbId) or a CurseForge project id (cfProject).
 */
export async function findModInPacksAction(opts: { modDbId?: number; cfProject?: number }) {
    if (opts.modDbId !== undefined) {
        const rows = await findPacksForMod(opts.modDbId);
        return { modDbId: opts.modDbId, packs: rows };
    }
    if (opts.cfProject !== undefined) {
        const rows = await findPacksForCfProject(opts.cfProject);
        return { cfProject: opts.cfProject, packs: rows };
    }
    throw new Error("Provide either modDbId or cfProject");
}

/**
 * Download and extract the overrides ZIP (KubeJS scripts, configs, defaultconfigs,
 * resource overrides, etc.) for a CurseForge pack version.
 *
 * The overrides are extracted to:
 *   CACHE_ROOT/packs/curseforge/{packId}/{versionId}/overrides/
 *
 * The corresponding PackFile record is updated to status "extracted".
 */
export async function downloadOverridesAction(opts: {
    namespace:  string;
    packId:     number;
    versionId:  number;
    force?:     boolean;
}) {
    const { namespace, packId, versionId, force = false } = opts;

    const manifest = namespace === "curseforge"
        ? await getCfPackManifest(packId, versionId)
        : await getPackManifest(packId, versionId);

    if (!manifest) throw new Error(`Manifest not found for pack ${packId} v${versionId} (${namespace})`);

    const overrideFile = manifest.files.find((f) => f.type === "cf-extract");
    if (!overrideFile) throw new Error("No cf-extract (overrides) entry found in manifest");

    // Use the URL from the manifest (the full CF pack ZIP like "All the Mods 10-7.0.zip")
    const url = resolveFileUrl(overrideFile);
    if (!url) throw new Error(`No download URL for cf-extract entry in pack ${packId} v${versionId}`);

    const packCacheDir  = join(CACHE_ROOT, "packs", namespace, String(packId), String(versionId));
    // Store under the real filename, not "overrides.zip"
    const urlFilename   = decodeURIComponent(url.split("/").pop() ?? "pack.zip");
    const zipPath       = join(packCacheDir, urlFilename);
    const extractDir    = join(packCacheDir, "overrides");

    await mkdir(packCacheDir, { recursive: true });

    // Download if not cached (or forced)
    if (force || !(await exists(zipPath))) {
        const tmpPath = zipPath + ".tmp";
        const res = await fetchWithRetry(url, { headers: MOD_HEADERS }, DOWNLOAD_OPTS);
        if (!res.ok) throw new Error(`Failed to download overrides.zip: HTTP ${res.status} from ${url}`);
        const writer = createWriteStream(tmpPath);
        await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
        await rename(tmpPath, zipPath);
    }

    // Extract with zip-slip protection: validate each entry resolves inside extractDir
    await mkdir(extractDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    const resolvedExtractDir = resolve(extractDir);
    for (const entry of zip.getEntries()) {
        const target = resolve(extractDir, entry.entryName);
        if (!target.startsWith(resolvedExtractDir + require("path").sep) && target !== resolvedExtractDir) {
            throw new Error(`Zip-slip detected: entry "${entry.entryName}" escapes extract dir`);
        }
    }
    zip.extractAllTo(extractDir, /* overwrite */ true);

    const entries = zip.getEntries().map((e) => e.entryName);
    const topDirs = [...new Set(entries.map((e) => e.split("/")[0]))].sort();

    // Update pack_file status in DB
    const pv = await findPackVersion(namespace, packId, versionId);
    if (pv) {
        await upsertPackFile({
            packVersionId:  pv.id,
            manifestFileId: overrideFile.id,
            fileType:       overrideFile.type,
            fileName:       overrideFile.name,
            filePath:       overrideFile.path || null,
            status:         "extracted",
        });
    }

    return {
        status:      "extracted",
        zipPath,
        extractDir,
        fileCount:   entries.length,
        topDirs,
        url,
    };
}
