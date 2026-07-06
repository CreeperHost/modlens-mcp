import { fetchWithRetry, safeJson } from "./fetch-utils.js";
import type { PlatformAdapter } from "./platform-adapter.js";

const MODRINTH_BASE = "https://api.modrinth.com/v2";
const token = process.env.MODRINTH_TOKEN ?? "";

const headers: Record<string, string> = {
    "User-Agent": "modlens-mcp/1.0 (github.com/CreeperHost/modlens-mcp)",
    ...(token ? { Authorization: token } : {}),
};

export interface ModrinthVersion {
    id: string;
    project_id: string;
    name: string;
    version_number: string;
    version_type?: string;
    game_versions?: string[];
    loaders?: string[];
    date_published: string;
    downloads: number;
    files: Array<{
        url: string;
        filename: string;
        primary: boolean;
        size?: number;
        file_type?: string | null;
        hashes: { sha512: string; sha1?: string; };
    }>;
}

export interface ModrinthProject {
    id: string;
    slug: string;
    title: string;
    description: string;
    project_type?: string;
    source_url: string | null;
    issues_url: string | null;
}

export async function lookupBySha512(sha512: string): Promise<ModrinthVersion | null> {
    if (!/^[a-f0-9]{128}$/i.test(sha512))
        throw new Error(`Invalid SHA-512 hash: expected 128 hex chars, got ${sha512.length} chars`);
    const res = await fetchWithRetry(`${MODRINTH_BASE}/version_file/${sha512}?algorithm=sha512`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Modrinth lookup failed: ${res.status}`);
    return safeJson<ModrinthVersion>(res, "Modrinth version lookup");
}

export async function getProject(projectId: string): Promise<ModrinthProject | null> {
    const res = await fetchWithRetry(`${MODRINTH_BASE}/project/${projectId}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Modrinth project fetch failed: ${res.status}`);
    return safeJson<ModrinthProject>(res, "Modrinth project");
}

export async function getLatestVersion(projectId: string, mcVersion?: string): Promise<ModrinthVersion | null> {
    const params = new URLSearchParams({ loaders: '["fabric","neoforge","forge","quilt"]' });
    if (mcVersion) params.set("game_versions", JSON.stringify([mcVersion]));
    const res = await fetchWithRetry(`${MODRINTH_BASE}/project/${projectId}/version?${params}`, { headers });
    if (!res.ok) return null;
    const versions = await safeJson<ModrinthVersion[]>(res, "Modrinth versions");
    return versions[0] ?? null;
}

export interface ModrinthSearchHit {
    project_id: string;
    slug: string;
    title: string;
    description: string;
    categories: string[];
    downloads: number;
    follows: number;
    latest_version: string;
    versions: string[];   // game versions
    loaders: string[];
    date_modified: string;
    license: string;
    project_type: string; // "mod" | "modpack" | "resourcepack" | "shader"
}

export interface ModrinthSearchResult {
    hits: ModrinthSearchHit[];
    offset: number;
    limit: number;
    total_hits: number;
}

/**
 * Search Modrinth by name/keyword, optionally filtered by loader and/or MC version.
 */
export async function searchProjects(
    query: string,
    opts: { loader?: string; mcVersion?: string; limit?: number; projectType?: string } = {},
): Promise<ModrinthSearchResult | null> {
    const facets: string[][] = [["project_type:mod"]];
    if (opts.loader)    facets.push([`categories:${opts.loader}`]);
    if (opts.mcVersion) facets.push([`versions:${opts.mcVersion}`]);
    if (opts.projectType) facets[0] = [`project_type:${opts.projectType}`];

    const params = new URLSearchParams({
        query,
        limit: String(opts.limit ?? 20),
        facets: JSON.stringify(facets),
    });
    const res = await fetchWithRetry(`${MODRINTH_BASE}/search?${params}`, { headers });
    if (!res.ok) return null;
    return safeJson<ModrinthSearchResult>(res, "Modrinth search");
}

/**
 * Get all versions for a project, optionally filtered by loader and/or MC version.
 */
export async function getProjectVersions(
    projectId: string,
    opts: { loader?: string; mcVersion?: string } = {},
): Promise<ModrinthVersion[]> {
    const params = new URLSearchParams();
    if (opts.loader)    params.set("loaders", JSON.stringify([opts.loader]));
    if (opts.mcVersion) params.set("game_versions", JSON.stringify([opts.mcVersion]));
    params.set("include_changelog", "false");
    const res = await fetchWithRetry(`${MODRINTH_BASE}/project/${projectId}/version?${params}`, { headers });
    if (!res.ok) return [];
    return safeJson<ModrinthVersion[]>(res, "Modrinth project versions");
}

export async function getProjectVersion(
    projectId: string,
    versionRef: string,
): Promise<ModrinthVersion | null> {
    const res = await fetchWithRetry(
        `${MODRINTH_BASE}/project/${projectId}/version/${encodeURIComponent(versionRef)}`,
        { headers },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Modrinth version fetch failed: ${res.status}`);
    return safeJson<ModrinthVersion>(res, "Modrinth project version");
}

export async function getVersion(versionId: string): Promise<ModrinthVersion | null> {
    const res = await fetchWithRetry(
        `${MODRINTH_BASE}/version/${encodeURIComponent(versionId)}`,
        { headers },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Modrinth version fetch failed: ${res.status}`);
    return safeJson<ModrinthVersion>(res, "Modrinth version");
}

export function getPrimaryFile(version: ModrinthVersion): ModrinthVersion["files"][number] | null {
    return version.files.find((f) => f.primary) ?? version.files[0] ?? null;
}

export const modrinthPlatformAdapter: PlatformAdapter = {
    name: "modrinth",
    async lookup({ sha512 }) {
        if (!sha512) return null;
        const ver = await lookupBySha512(sha512).catch(() => null);
        if (!ver) return null;
        const proj = await getProject(ver.project_id).catch(() => null);
        return {
            platform: "modrinth" as const,
            projectId: ver.project_id,
            slug:      proj?.slug,
            sourceUrl: proj?.source_url,
        };
    },
};
