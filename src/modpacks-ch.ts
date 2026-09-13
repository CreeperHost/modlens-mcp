/**
 * modpacks.ch public API client.
 *
 * modpacks.ch is a service by CreeperHost (https://www.creeperhost.net).
 * The API is freely accessible — no auth required.
 * The modpacks.ch team requested a custom User-Agent for usage tracking.
 */
import { fetchWithRetry, DOWNLOAD_OPTS } from "./fetch-utils.js";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { matchesVersionRange } from "./version-ranges.js";

export const MODPACKS_CH_API = "https://api.modpacks.ch/public";
const CURSEFORGE_API_KEY = process.env.CURSEFORGE_API_KEY ?? "";

/** User-Agent as requested by the modpacks.ch (CreeperHost) team for usage tracking. */
export const USER_AGENT = "modlens-mcp/1.0 (github.com/CreeperHost/modlens-mcp)";
const HEADERS = { "User-Agent": USER_AGENT };

// ── API type definitions ──────────────────────────────────────────────────────

export interface Artwork {
    id:         number;
    url:        string;
    type:       string;  // "square" | "wide" | "splash" | "background"
    width:      number;
    height:     number;
    compressed: boolean;
    sha1:       string;
    size:       number;
    updated:    number;
}

export interface Link {
    id:   number;
    name: string;
    link: string;
    type: string;  // "curseforge" | "modrinth" | "website" | "discord" | "github"
}

export interface Tag {
    id:   number;
    name: string;
}

export interface Author {
    id:      number;
    name:    string;
    type:    string;  // "Owner" | "Contributor"
    updated: number;
    website: string;
}

// ── Mod endpoint types ────────────────────────────────────────────────────────

/**
 * A single version/file entry inside GET /mod/{id}.
 * Contains full file metadata and CDN download URL — no CF API key required.
 */
export interface ModVersion {
    id:         number | string; // CurseForge file ID or Modrinth version ID
    name:       string;   // filename e.g. "jei-26.1.2-neoforge-29.5.0.28.jar"
    version:    string;   // human-readable version string
    type:       string;   // "Release" | "Beta" | "Alpha"
    path:       string;   // destination path e.g. "mods/"
    url:        string;   // direct CDN download URL (may be empty — construct from cfCdnUrl)
    mirrors:    string[]; // mirror URLs
    sha1:       string;
    size:       number;
    clientonly: boolean;
    updated:    number;   // Unix timestamp
    targets:    Target[];
    dependencies: ModDependency[];
    /** Present only when missing loader targets were recovered from the artifact. */
    loaderSource?: "jar";
}

export interface ModDependency {
    id:       number | string;
    name:     string;
    type:     string;  // "required" | "optional"
    version?: string;
    updated:  number;
}

/** Response from GET /mod/{id} */
export interface ModMetadata {
    id:        number | string;  // integer = CF project ID, string = Modrinth project ID
    name:      string;
    synopsis:  string;
    art:       Artwork[];
    links:     Link[];
    versions:  ModVersion[];
    installs:  number;
    plays:     number;
    status:    string;  // "public"
    updated:   number;
    refreshed: number;
    description?: string;
    provider?: string;
    slug?: string;
    tags?: Tag[] | null;
    targets?: Target[] | null;
    loaderSource?: "jar";
}

/** Response from GET /mod/search/{limit}?term={q} */
export interface ModSearchResult {
    mods:  (number | string)[];
    total: number;
    limit: number;
    term:  string;
}

// ── Modpack endpoint types ────────────────────────────────────────────────────

export interface PackVersionRef {
    id:      number;
    name:    string;
    type:    string;  // "Release" | "Beta" | "Alpha"
    updated: number;
    targets: Target[];
}

export interface Target {
    id:      number;
    name:    string;     // "minecraft" | "neoforge" | "forge" | "fabric"
    version: string;
    type:    string;     // "game" | "modloader"
    updated: number;
}

/** Response from GET /modpack/{id} */
export interface PackMetadata {
    id:          number;
    name:        string;
    synopsis:    string;
    description: string;
    art:         Artwork[];
    links:       Link[];
    authors:     Author[];
    versions:    PackVersionRef[];
    installs:    number;
    plays:       number;
    tags:        Tag[];
    status:      string;
    provider:    string;  // "modpacksch"
    updated:     number;
    rating:      { id: number; likes: number; dislikes: number; stars: number; reviews: number } | null;
}

/** Response from GET /modpack/search/{limit}?term={q} */
export interface PackSearchResult {
    packs:       number[];
    curseforge?: number[];   // CF pack IDs returned alongside FTB pack IDs
    total:       number;
    limit:       number;
    term?:       string;
    refreshed?:  number;
}

// ── Manifest types ────────────────────────────────────────────────────────────

export interface ManifestFile {
    id:         number;
    name:       string;
    /**
     * File type — key distinction for ingestion:
     *  "mod"      → JAR, has curseforge field, downloadable and ingestable
     *  "resource" → resource/data pack ZIP, downloadable
     *  "config"   → config file, downloadable
     *  "script"   → CraftTweaker/KubeJS script, downloadable
     *  "override" → misc override file
     */
    type:       string;
    path:       string;   // destination path relative to pack root
    url:        string;   // direct CDN download URL (no auth needed)
    mirror:     string;   // mirror URL
    sha1:       string;
    size:       number;
    clientonly: boolean;
    serveronly: boolean;
    optional:   boolean;
    tags:       string[];
    /** Present on mod-type files — provides direct CF project/file IDs (no CF API key needed). */
    curseforge?: { project: number; file: number };
}

/** Response from GET /modpack/{packId}/{versionId} */
export interface PackManifest {
    id:        number;    // = versionId
    parent:    number;    // = packId
    name:      string;
    type:      string;    // "Release" | "Beta" | "Alpha"
    version:   string;
    targets:   Target[];
    files:     ManifestFile[];
    specs:     { id: number; minimum: number; recommended: number };
    installs:  number;
    plays:     number;
    updated:   number;
    refreshed: number;
    status:    string;
}

// ── API helpers ───────────────────────────────────────────────────────────────

export async function modpacksChGet<T>(path: string): Promise<T | null> {
    const res = await fetchWithRetry(`${MODPACKS_CH_API}/${path}`, { headers: HEADERS });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`modpacks.ch API ${res.status} for /${path}`);
    const text = await res.text();
    let data: { status?: string; message?: string };
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`modpacks.ch returned non-JSON for /${path}`);
    }
    if (data.status === "error") {
        if (/^mod\/[a-f\d]{40}$/i.test(path) && data.message === "Unable to find mod with this checksum") return null;
        throw new Error(`modpacks.ch: ${data.message ?? "Request failed"}`);
    }
    return data as T;
}

// ── Mod API ───────────────────────────────────────────────────────────────────

export async function searchMods(term: string, limit = 20): Promise<ModSearchResult | null> {
    const result = await get<Omit<ModSearchResult,"mods"> & {mods:Array<number | string | ModMetadata>}>(`mod/search/${limit}?term=${encodeURIComponent(term)}`);
    return result ? {...result,mods:result.mods.map(entry => typeof entry === "object" ? entry.id : entry)} : null;
}

export async function getMod(id: number | string): Promise<ModMetadata | null> {
    return get<ModMetadata>(`mod/${encodeURIComponent(id)}`);
}

/**
 * Batch-fetch multiple mods by their IDs. Useful after a search to enrich
 * result IDs into full mod objects. Runs requests in parallel.
 */
export async function getModsBatch(ids: (number | string)[]): Promise<ModMetadata[]> {
    const results = await Promise.allSettled(ids.map((id) => getMod(id)));
    return results
        .filter((r): r is PromiseFulfilledResult<ModMetadata> => r.status === "fulfilled" && r.value !== null)
        .map((r) => r.value);
}

/**
 * Resolve the download URL for a mod version.
 * Some entries have url="" — in that case the CDN URL is constructed from
 * the file ID using the same cfCdnUrl pattern as pack manifests.
 */
export function resolveModVersionUrl(version: ModVersion): string | null {
    if (version.url) return withCurseForgeApiKey(version.url);
    if (version.mirrors?.length) return withCurseForgeApiKey(version.mirrors[0]);
    if (/^\d+$/.test(String(version.id)) && Number(version.id) > 0) return cfCdnUrl(Number(version.id), version.name);
    return null;
}

// ── Modpack API (FTB namespace) ───────────────────────────────────────────────

export async function searchPacks(term: string, limit = 20): Promise<PackSearchResult | null> {
    return get<PackSearchResult>(`modpack/search/${limit}?term=${encodeURIComponent(term)}`);
}

export async function getFeaturedPacks(limit = 20): Promise<{ packs: number[]; total: number } | null> {
    return get<{ packs: number[]; total: number }>(`modpack/featured/${limit}`);
}

export async function getPack(packId: number): Promise<PackMetadata | null> {
    const pack = await get<PackMetadata>(`modpack/${packId}`);
    return pack ? { ...pack, versions: await packVersions("modpack", pack.id) } : null;
}

export async function getPackManifest(packId: number, versionId: number): Promise<PackManifest | null> {
    return get<PackManifest>(`modpack/${packId}/${versionId}`);
}

// ── CurseForge modpack API (no CF API key required) ───────────────────────────
// Mirrors the /modpack/ namespace but for CurseForge-hosted packs.
// provider field will be "curseforge" in all responses.

/**
 * Search CurseForge packs via the unified modpacks.ch search endpoint.
 * Provider-specific browsing is also available through providerSearch.
 */
export async function searchCfPacks(term: string, limit = 20): Promise<PackSearchResult | null> {
    return searchPacks(term, limit);
}

export async function getCfPack(packId: number): Promise<PackMetadata | null> {
    const pack = await get<PackMetadata>(`curseforge/${packId}`);
    return pack ? { ...pack, versions: await packVersions("curseforge", pack.id) } : null;
}

export async function getCfPackManifest(packId: number, versionId: number): Promise<PackManifest | null> {
    return get<PackManifest>(`curseforge/${packId}/${versionId}`);
}

/**
 * Build a direct CurseForge CDN download URL for a manifest file whose `url`
 * is empty (CF packs return url: "" for mod-type files).
 *
 * Pattern: https://edge.forgecdn.net/files/{fileId÷1000}/{fileId%1000}/{name}
 */
export function cfCdnUrl(fileId: number, filename: string): string {
    const hi  = Math.floor(fileId / 1000);
    const lo  = fileId % 1000;
    return withCurseForgeApiKey(`https://edge.forgecdn.net/files/${hi}/${lo}/${encodeURIComponent(filename)}`);
}

const get = modpacksChGet;

export async function providerSearch(
    provider: "modrinth" | "curseforge", kind: "mod" | "modpack", term: string,
    opts: { loader?: string; mcVersion?: string; limit?: number } = {},
): Promise<ModMetadata[]> {
    const verifyModLoader = kind === "mod" && !!opts.loader;
    const filters = [opts.mcVersion, verifyModLoader ? undefined : opts.loader].filter(Boolean).map(v => encodeURIComponent(v!));
    const route = `${provider}/${kind === "mod" ? "mods/" : ""}search`;
    const rows: ModMetadata[] = [];
    const limit = opts.limit ?? 20;
    for (let page = 1; rows.length < limit && page <= 1000; page++) {
        // Numeric path segments select the page; "all" is not a browse filter.
        const result = await get<{ mods?: ModMetadata[]; packs?: ModMetadata[]; pages?: number }>(
            `${route}/${[...filters, page].join("/")}?term=${encodeURIComponent(term)}`,
        );
        if (!result) break;
        const entries = result.mods ?? result.packs;
        if (!Array.isArray(entries)) throw new Error("modpacks.ch returned an invalid search page");
        for (let entry of entries) {
            if (verifyModLoader) {
                const [version] = await providerVersions("mod", entry.id, { ...opts, limit: 1 });
                if (!version) continue;
                entry = { ...entry, versions: [version], targets: version.targets,
                    ...(version.loaderSource ? { loaderSource: version.loaderSource } : {}) };
            }
            rows.push(entry);
            if (rows.length >= limit) break;
        }
        if (!entries.length || page >= Number(result.pages ?? 1)) break;
        if (page === 1000 && rows.length < limit) throw new Error("modpacks.ch search pagination exceeded 1000 pages");
    }
    return rows.slice(0, limit);
}

export async function providerVersions(
    namespace: "mod" | "modrinth" | "modpack" | "ftb" | "curseforge", id: string | number,
    opts: { loader?: string; mcVersion?: string; mcVersionRange?: string; limit?: number; force?: boolean } = {},
): Promise<ModVersion[]> {
    const loader = opts.loader?.trim().toLowerCase();
    // An upstream loader filter hides unlabeled files, including newer files of
    // otherwise labeled projects. Keep upstream ordering and filter each record.
    const inspectMissingLoaders = namespace === "mod" && !!loader;
    const filters = [opts.mcVersion, inspectMissingLoaders ? undefined : loader].filter(Boolean).map(v => encodeURIComponent(v!));
    const route = `${namespace}/${encodeURIComponent(id)}/versions/${filters.join("/") || "all"}`;
    const versions: ModVersion[] = [];
    const seen = new Set<string>();
    if (opts.limit !== undefined && opts.limit <= 0) return versions;
    for (let page = 1; page <= 1000; page++) {
        const result = await get<{ versions: ModVersion[]; pages?: number }>(`${route}/${page}`);
        if (!result) break;
        if (!Array.isArray(result.versions)) throw new Error("modpacks.ch returned an invalid version page");
        for (let version of result.versions) {
            if (seen.has(String(version.id))) continue;
            seen.add(String(version.id));
            if (namespace === "mod" && opts.mcVersion && !version.targets?.some(target => target.type === "game" && target.version === opts.mcVersion)) continue;
            if (opts.mcVersionRange && !version.targets?.some(target => target.type === "game" && matchesVersionRange(target.version, opts.mcVersionRange))) continue;
            if (inspectMissingLoaders) {
                let loaders = (version.targets ?? []).filter(target => target.type === "modloader")
                    .map(target => target.name?.trim().toLowerCase()).filter(name => name && name !== "unknown");
                if (!loaders.length) {
                    const { downloadModVersion } = await import("./mod-artifacts.js");
                    const { inspectJarLoaders } = await import("./processor.js");
                    try {
                        loaders = await inspectJarLoaders(await downloadModVersion(id, version, opts.force));
                    } catch (error) {
                        throw new Error(`Unable to inspect loader for ${version.name} (${version.id}): ${error instanceof Error ? error.message : String(error)}`);
                    }
                    version = { ...version, loaderSource: "jar", targets: [
                        ...(version.targets ?? []).filter(target => target.type !== "modloader"),
                        ...loaders.map(name => ({ id: -1, name, version: "", type: "modloader", updated: version.updated })),
                    ] };
                }
                if (!loaders.includes(loader!)) continue;
            }
            versions.push(version);
            if (versions.length >= (opts.limit ?? Infinity)) return versions;
        }
        if (versions.length >= (opts.limit ?? Infinity) || page >= Number(result.pages ?? 1)) break;
        if (page === 1000) throw new Error("modpacks.ch version pagination exceeded 1000 pages");
    }
    return versions;
}

export async function packVersions(namespace: "modpack" | "ftb" | "curseforge", id: number): Promise<PackVersionRef[]> {
    return (await providerVersions(namespace, id)).map(version => {
        const fileId = Number(version.id);
        if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error(`Invalid ${namespace} pack version ID`);
        return { ...version, id: fileId };
    });
}

export async function loaderVersions(mcVersion: string, loader: string) {
    const data = await get<{ loaders: Array<{ version: string; gameVersion: string; type: string }> }>(
        `loaders/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loader)}`,
    );
    return data?.loaders ?? [];
}

export function providerLink(record: ModMetadata, type: string): string | undefined {
    return record.links?.find(l => l.type?.toLowerCase() === type || l.name?.toLowerCase() === type)?.link;
}

/**
 * Attach an optional configured key only to CurseForge's own download hosts.
 */
export function withCurseForgeApiKey(rawUrl: string): string {
    if (!CURSEFORGE_API_KEY || !rawUrl) return rawUrl;
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return rawUrl;
    }
    const host = url.hostname.toLowerCase();
    if (!["forgecdn.net", "curseforge.com"].some(domain => host === domain || host.endsWith(`.${domain}`))) return rawUrl;
    if (!url.searchParams.has("apiKey")) url.searchParams.set("apiKey", CURSEFORGE_API_KEY);
    return url.toString();
}

/**
 * Resolve the download URL for any manifest file, regardless of whether it
 * comes from an FTB pack (direct URL) or a CurseForge pack (empty url →
 * reconstruct from the embedded curseforge metadata).
 *
 * Returns null if the file type is not downloadable (e.g. "cf-extract"
 * overrides ZIPs that have their own url should still be fine, this only
 * returns null if there is genuinely no URL to construct).
 */
export function resolveFileUrl(file: ManifestFile): string | null {
    if (file.url) return withCurseForgeApiKey(file.url);
    if (file.mirror)     return withCurseForgeApiKey(file.mirror);
    if (file.curseforge) return cfCdnUrl(file.curseforge.file, file.name);
    // cf-extract overrides ZIPs use the version ID as their file ID
    if (file.type === "cf-extract" && file.id) return cfCdnUrl(file.id, file.name);
    return null;
}

// ── File download ─────────────────────────────────────────────────────────────

/**
 * Download a single FTB/CF manifest file to a local destination path.
 * Handles both FTB packs (direct CDN `url`) and CurseForge packs (empty `url`
 * → reconstruct via cfCdnUrl from embedded curseforge metadata).
 */
export async function downloadManifestFile(file: ManifestFile, destPath: string): Promise<void> {
    const primary = resolveFileUrl(file);
    if (!primary) throw new Error(`No download URL for file ${file.name} (id ${file.id})`);

    const attempt = async (url: string): Promise<Response> => {
        const res = await fetchWithRetry(url, { headers: HEADERS }, DOWNLOAD_OPTS);
        return res;
    };

    let res = await attempt(primary);
    if (!res.ok && file.mirror && file.mirror !== primary) {
        res = await attempt(file.mirror);
    }
    if (!res.ok) throw new Error(`Failed to download ${file.name}: HTTP ${res.status}`);

    const writer = createWriteStream(destPath);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
}
