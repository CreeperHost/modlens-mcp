/**
 * modpacks.ch / FTB tool — search and sync packs from both the FTB and
 * CurseForge namespaces exposed by the modpacks.ch public API (no API key
 * required for either).
 *
 * User-Agent spec: The FTB/modpacks.ch team requested a custom User-Agent for
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
import { join } from "path";
import { createHash } from "crypto";
import { rename } from "fs/promises";
import { ensureDir, exists, CACHE_ROOT } from "../cache.js";
import {
    searchPacks, getFeaturedPacks, getPack, getPackManifest,
    searchCfPacks, getCfPack, getCfPackManifest,
    searchMods, getMod,
    downloadManifestFile, resolveFileUrl,
    type FtbManifest, type FtbManifestFile,
} from "../modpacks-ch.js";
import { ingestMod } from "./ingest.js";

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
    status:    string;
    dbId?:     number;
    message?:  string;
}

// ── Pack search / browse ──────────────────────────────────────────────────────

export async function searchPacksAction(term: string, namespace: PackNamespace = "ftb", limit = 20) {
    if (namespace === "curseforge") {
        const r = await searchCfPacks(term, limit);
        if (!r) return { packs: [], total: 0 };
        return r;
    }
    const r = await searchPacks(term, limit);
    if (!r) return { packs: [], total: 0 };
    return r;
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
        tags:     pack.tags.map((t) => t.name),
        authors:  pack.authors.map((a) => ({ name: a.name, type: a.type })),
        links:    pack.links.map((l) => ({ type: l.type, url: l.link })),
        versions: pack.versions.map((v) => ({
            id:      v.id,
            name:    v.name,
            type:    v.type,
            targets: v.targets.map((t) => ({ name: t.name, version: t.version })),
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

    return {
        id:        manifest.id,
        parent:    manifest.parent,
        name:      manifest.name,
        version:   manifest.version,
        type:      manifest.type,
        targets:   manifest.targets.map((t) => ({ name: t.name, version: t.version })),
        fileCount: manifest.files.length,
        byType:    Object.fromEntries(
            [...new Set(manifest.files.map((f) => f.type))].map((t) => [
                t,
                manifest.files.filter((f) => f.type === t).length,
            ]),
        ),
        files: manifest.files.map(fileSummary),
    };
}

// ── FTB mod search ────────────────────────────────────────────────────────────

export async function searchFtbModsAction(term: string, limit = 20) {
    const r = await searchMods(term, limit);
    if (!r) return { mods: [], total: 0 };
    return r;
}

export async function ftbModInfoAction(modId: number | string) {
    const m = await getMod(modId);
    if (!m) throw new Error(`FTB mod ${modId} not found`);
    return {
        id:      m.id,
        name:    m.name,
        synopsis: m.synopsis,
        installs: m.installs,
        links:   m.links,
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
    packId:    number;
    versionId: number;
    namespace: string;
    total:     number;
    ingested:  number;
    skipped:   number;
    failed:    number;
    files:     FileResult[];
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

    const ingested = results.filter((r) => r.status === "ingested" || r.status === "replaced").length;
    const skipped  = results.filter((r) => r.status === "already_ingested" || r.status === "duplicate_version" || r.status === "duplicate_hash").length;
    const failed   = results.filter((r) => r.status === "error").length;

    return {
        packId,
        versionId,
        namespace,
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
            return { name: file.name, type: file.type, status: "downloaded_zip" };
        }

        const result = await ingestMod(destPath, /* skipSource */ true);
        return {
            name:    file.name,
            type:    file.type,
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
            status:  "error",
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
