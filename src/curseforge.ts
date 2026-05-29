import { fetchWithRetry } from "./fetch-utils.js";
import type { PlatformAdapter } from "./platform-adapter.js";

const CF_BASE = "https://api.curseforge.com/v1";
const CF_KEY = process.env.CURSEFORGE_API_KEY ?? "";
const MINECRAFT_GAME_ID = 432;

const headers: Record<string, string> = {
    "x-api-key": CF_KEY,
    "Content-Type": "application/json",
    "User-Agent": "modlens-mcp/1.0",
};

export interface CFProject {
    id: number;
    name: string;
    slug: string;
    links: { sourceUrl?: string; websiteUrl?: string; };
    latestFiles: CFFile[];
}

export interface CFFile {
    id: number;
    displayName: string;
    fileName: string;
    fileDate: string;
    downloadUrl: string;
    gameVersions: string[];
}

export async function lookupByFingerprint(murmur2: number): Promise<CFProject | null> {
    if (!Number.isFinite(murmur2) || murmur2 < 0)
        throw new Error(`Invalid murmur2 fingerprint: expected non-negative integer, got ${murmur2}`);
    const res = await fetchWithRetry(`${CF_BASE}/fingerprints/${MINECRAFT_GAME_ID}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fingerprints: [murmur2] }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: { exactMatches: Array<{ file: CFFile; id: number; }>; }; };
    const match = data.data.exactMatches[0];
    if (!match) return null;
    return getProject(match.id);
}

export async function getProject(modId: number): Promise<CFProject | null> {
    const res = await fetchWithRetry(`${CF_BASE}/mods/${modId}`, { headers });
    if (!res.ok) return null;
    const data = await res.json() as { data: CFProject; };
    return data.data;
}

export async function getLatestFile(modId: number, mcVersion?: string): Promise<CFFile | null> {
    const project = await getProject(modId);
    if (!project) return null;
    const files = project.latestFiles.filter((f) =>
        mcVersion ? f.gameVersions.includes(mcVersion) : true
    );
    return files[0] ?? null;
}

export interface CFSearchHit {
    id: number;
    name: string;
    slug: string;
    summary: string;
    downloadCount: number;
    dateModified: string;
    latestFiles: CFFile[];
    links: { sourceUrl?: string; websiteUrl?: string };
}

/**
 * Search CurseForge mods by name/keyword. Requires CURSEFORGE_API_KEY.
 * Returns null if no API key is configured.
 */
export async function searchMods(
    query: string,
    opts: { loader?: string; mcVersion?: string; limit?: number } = {},
): Promise<CFSearchHit[] | null> {
    if (!CF_KEY) return null;
    const params = new URLSearchParams({
        gameId:   String(MINECRAFT_GAME_ID),
        classId:  "6",       // 6 = Mods category on CurseForge
        searchFilter: query,
        pageSize: String(opts.limit ?? 20),
    });
    if (opts.mcVersion) params.set("gameVersion", opts.mcVersion);
    if (opts.loader)    params.set("modLoaderType", modloaderToEnum(opts.loader));
    const res = await fetchWithRetry(`${CF_BASE}/mods/search?${params}`, { headers });
    if (!res.ok) return null;
    const data = await res.json() as { data: CFSearchHit[] };
    return data.data;
}

/** Map a loader string to CurseForge's modLoaderType enum value. */
function modloaderToEnum(loader: string): string {
    const map: Record<string, string> = {
        forge: "1", fabric: "4", quilt: "5", neoforge: "6",
    };
    return map[loader.toLowerCase()] ?? "0";
}

/**
 * Get all files for a CF project, optionally filtered by MC version.
 */
export async function getProjectFiles(
    modId: number,
    opts: { mcVersion?: string; limit?: number } = {},
): Promise<CFFile[]> {
    if (!CF_KEY) return [];
    const params = new URLSearchParams({ pageSize: String(opts.limit ?? 20) });
    if (opts.mcVersion) params.set("gameVersion", opts.mcVersion);
    const res = await fetchWithRetry(`${CF_BASE}/mods/${modId}/files?${params}`, { headers });
    if (!res.ok) return [];
    const data = await res.json() as { data: CFFile[] };
    return data.data;
}

export const curseforgePlatformAdapter: PlatformAdapter = {
    name: "curseforge",
    async lookup({ murmur2 }) {
        if (!murmur2) return null;
        const m = parseInt(murmur2, 10);
        if (isNaN(m)) return null;
        const proj = await lookupByFingerprint(m).catch(() => null);
        if (!proj) return null;
        return {
            platform: "curseforge" as const,
            projectId: proj.id,
            slug:      proj.slug,
            sourceUrl: proj.links?.sourceUrl,
        };
    },
};
