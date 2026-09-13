import { fetchWithRetry, safeJson } from "./fetch-utils.js";
import {
    getMod, providerVersions, providerSearch, providerLink, resolveModVersionUrl,
    type ModMetadata, type ModVersion,
} from "./modpacks-ch.js";
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
    sha1?: string;
    displayName: string;
    fileName: string;
    fileDate: string;
    downloadUrl: string;
    gameVersions: string[];
    loaderSource?: "jar";
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
    const data = await safeJson<{ data: { exactMatches: Array<{ file: CFFile; id: number; }>; }; }>(res, "CurseForge fingerprint");
    const match = data.data.exactMatches[0];
    if (!match) return null;
    return getProject(match.id);
}

function asCFFile(version: ModVersion): CFFile {
    return {
        id: Number(version.id),
        sha1: version.sha1,
        displayName: version.version ?? version.name,
        fileName: version.name,
        fileDate: new Date((version.updated ?? 0) * 1000).toISOString(),
        downloadUrl: resolveModVersionUrl(version) ?? "",
        gameVersions: (version.targets ?? []).map(target => target.type === "game" ? target.version : target.name),
        ...(version.loaderSource ? { loaderSource: version.loaderSource } : {}),
    };
}

function asCFProject(project: ModMetadata): CFProject {
    return {
        id: Number(project.id),
        name: project.name,
        slug: project.slug ?? String(project.id),
        links: {
            sourceUrl: providerLink(project, "source") ?? providerLink(project, "github"),
            websiteUrl: providerLink(project, "website"),
        },
        latestFiles: (project.versions ?? []).map(asCFFile),
    };
}

export async function getProject(modId: number): Promise<CFProject | null> {
    const p = await getMod(modId);
    return p ? asCFProject(p) : null;
}
export async function lookupProjectByHash(hash: string): Promise<CFProject | null> {
    const project = await getMod(hash);
    if (!project || (project.provider && project.provider !== "curseforge") || !/^\d+$/.test(String(project.id))) return null;
    return asCFProject(project);
}

export async function getLatestFile(modId: number, mcVersion?: string, loader?: string): Promise<CFFile | null> {
    if (mcVersion && !/^\d+(?:\.\d+)*$/.test(mcVersion)) {
        const [latest] = await providerVersions("mod", modId, { loader, mcVersionRange: mcVersion, limit: 1 });
        return latest ? asCFFile(latest) : null;
    }
    return (await getProjectFiles(modId, {mcVersion,loader,limit:1}))[0] ?? null;
}

export interface CFSearchHit {
    id: number;
    name: string;
    slug: string;
    summary: string;
    downloadCount: number;
    dateModified: string;
    latestFiles: CFFile[];
    loaders?: string[];
    loaderSource?: "jar";
    links: { sourceUrl?: string; websiteUrl?: string };
}

/**
 * Search CurseForge mods through modpacks.ch; no API key is required.
 */
export async function searchMods(query: string, opts: {loader?: string; mcVersion?: string; limit?: number} = {}): Promise<CFSearchHit[]> {
    return (await providerSearch("curseforge", "mod", query, opts)).map(p=>({...asCFProject(p),
        summary:p.synopsis ?? "", downloadCount:p.installs ?? 0,
        loaders:(p.targets ?? []).filter(target=>target.type === "modloader").map(target=>target.name),
        ...(p.loaderSource ? {loaderSource:p.loaderSource} : {}),
        dateModified:new Date((p.updated ?? 0)*1000).toISOString()}));
}

export async function getProjectFiles(modId: number, opts: {mcVersion?: string; loader?: string; limit?: number} = {}): Promise<CFFile[]> {
    return (await providerVersions("mod",modId,{...opts,limit:opts.limit ?? 20})).map(asCFFile);
}

export const curseforgePlatformAdapter: PlatformAdapter = {
    name: "curseforge",
    async lookup({ sha1 }) {
        if (!sha1) return null;
        const proj = await lookupProjectByHash(sha1);
        if (!proj) return null;
        return {
            platform: "curseforge" as const,
            projectId: proj.id,
            slug:      proj.slug,
            sourceUrl: proj.links?.sourceUrl,
        };
    },
};
