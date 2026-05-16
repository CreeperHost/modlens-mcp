/**
 * modpacks.ch / FTB public API client.
 *
 * API is freely accessible — no auth required.
 * The FTB team (Gigabit101) requested a custom User-Agent for usage tracking.
 */
import { fetchWithRetry, DOWNLOAD_OPTS } from "./fetch-utils.js";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

export const FTBAPI = "https://api.modpacks.ch/public";

/** User-Agent as requested by the FTB/modpacks.ch team for usage tracking. */
export const USER_AGENT = "modlens-mcp/1.0 (github.com/Mattabase/modlens-mcp)";
const HEADERS = { "User-Agent": USER_AGENT };

// ── API type definitions ──────────────────────────────────────────────────────

export interface FtbArt {
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

export interface FtbLink {
    id:   number;
    name: string;
    link: string;
    type: string;  // "curseforge" | "modrinth" | "website" | "discord" | "github"
}

export interface FtbTag {
    id:   number;
    name: string;
}

export interface FtbAuthor {
    id:      number;
    name:    string;
    type:    string;  // "Owner" | "Contributor"
    updated: number;
    website: string;
}

// ── Mod endpoint types ────────────────────────────────────────────────────────

export interface FtbModVersionRef {
    id:      number;
    name:    string;
    type:    string;  // "Release" | "Beta" | "Alpha"
    updated: number;
}

/** Response from GET /mod/{id} */
export interface FtbMod {
    id:        number | string;  // integer = CF project ID, string = Modrinth project ID
    name:      string;
    synopsis:  string;
    art:       FtbArt[];
    links:     FtbLink[];
    versions:  FtbModVersionRef[];
    installs:  number;
    plays:     number;
    status:    string;  // "public"
    updated:   number;
    refreshed: number;
}

/** Response from GET /mod/search/{limit}?term={q} */
export interface FtbModSearchResult {
    mods:  (number | string)[];
    total: number;
    limit: number;
    term:  string;
}

// ── Modpack endpoint types ────────────────────────────────────────────────────

export interface FtbPackVersionRef {
    id:      number;
    name:    string;
    type:    string;  // "Release" | "Beta" | "Alpha"
    updated: number;
    targets: FtbTarget[];
}

export interface FtbTarget {
    id:      number;
    name:    string;     // "minecraft" | "neoforge" | "forge" | "fabric"
    version: string;
    type:    string;     // "game" | "modloader"
    updated: number;
}

/** Response from GET /modpack/{id} */
export interface FtbPack {
    id:          number;
    name:        string;
    synopsis:    string;
    description: string;
    art:         FtbArt[];
    links:       FtbLink[];
    authors:     FtbAuthor[];
    versions:    FtbPackVersionRef[];
    installs:    number;
    plays:       number;
    tags:        FtbTag[];
    status:      string;
    provider:    string;  // "modpacksch"
    updated:     number;
    rating:      { id: number; likes: number; dislikes: number; stars: number; reviews: number } | null;
}

/** Response from GET /modpack/search/{limit}?term={q} */
export interface FtbPackSearchResult {
    packs: number[];
    total: number;
    limit: number;
    term:  string;
}

// ── Manifest types ────────────────────────────────────────────────────────────

export interface FtbManifestFile {
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
export interface FtbManifest {
    id:        number;    // = versionId
    parent:    number;    // = packId
    name:      string;
    type:      string;    // "Release" | "Beta" | "Alpha"
    version:   string;
    targets:   FtbTarget[];
    files:     FtbManifestFile[];
    specs:     { id: number; minimum: number; recommended: number };
    installs:  number;
    plays:     number;
    updated:   number;
    refreshed: number;
    status:    string;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T | null> {
    const res = await fetchWithRetry(`${FTBAPI}/${path}`, { headers: HEADERS });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`modpacks.ch API ${res.status} for /${path}`);
    return res.json() as Promise<T>;
}

// ── Mod API ───────────────────────────────────────────────────────────────────

export async function searchMods(term: string, limit = 20): Promise<FtbModSearchResult | null> {
    return get<FtbModSearchResult>(`mod/search/${limit}?term=${encodeURIComponent(term)}`);
}

export async function getMod(id: number | string): Promise<FtbMod | null> {
    return get<FtbMod>(`mod/${id}`);
}

// ── Modpack API (FTB namespace) ───────────────────────────────────────────────

export async function searchPacks(term: string, limit = 20): Promise<FtbPackSearchResult | null> {
    return get<FtbPackSearchResult>(`modpack/search/${limit}?term=${encodeURIComponent(term)}`);
}

export async function getFeaturedPacks(limit = 20): Promise<{ packs: number[]; total: number } | null> {
    return get<{ packs: number[]; total: number }>(`modpack/featured/${limit}`);
}

export async function getPack(packId: number): Promise<FtbPack | null> {
    return get<FtbPack>(`modpack/${packId}`);
}

export async function getPackManifest(packId: number, versionId: number): Promise<FtbManifest | null> {
    return get<FtbManifest>(`modpack/${packId}/${versionId}`);
}

// ── CurseForge modpack API (no CF API key required) ───────────────────────────
// Mirrors the /modpack/ namespace but for CurseForge-hosted packs.
// provider field will be "curseforge" in all responses.

export async function searchCfPacks(term: string, limit = 20): Promise<FtbPackSearchResult | null> {
    return get<FtbPackSearchResult>(`curseforge/search/${limit}?term=${encodeURIComponent(term)}`);
}

export async function getCfPack(packId: number): Promise<FtbPack | null> {
    return get<FtbPack>(`curseforge/${packId}`);
}

export async function getCfPackManifest(packId: number, versionId: number): Promise<FtbManifest | null> {
    return get<FtbManifest>(`curseforge/${packId}/${versionId}`);
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
    return `https://edge.forgecdn.net/files/${hi}/${lo}/${encodeURIComponent(filename)}`;
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
export function resolveFileUrl(file: FtbManifestFile): string | null {
    if (file.url) return file.url;
    if (file.curseforge) return cfCdnUrl(file.curseforge.file, file.name);
    if (file.mirror)     return file.mirror;
    return null;
}

// ── File download ─────────────────────────────────────────────────────────────

/**
 * Download a single FTB/CF manifest file to a local destination path.
 * Handles both FTB packs (direct CDN `url`) and CurseForge packs (empty `url`
 * → reconstruct via cfCdnUrl from embedded curseforge metadata).
 */
export async function downloadManifestFile(file: FtbManifestFile, destPath: string): Promise<void> {
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
    if (!res.ok) throw new Error(`Failed to download ${file.name}: HTTP ${res.status} from ${primary}`);

    const writer = createWriteStream(destPath);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
}
