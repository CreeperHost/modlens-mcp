import { fetchWithRetry } from "./fetch-utils.js";

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
