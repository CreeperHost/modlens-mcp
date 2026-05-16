import { fetchWithRetry } from "./fetch-utils.js";

const MODRINTH_BASE = "https://api.modrinth.com/v2";
const token = process.env.MODRINTH_TOKEN ?? "";

const headers: Record<string, string> = {
    "User-Agent": "modlens-mcp/1.0 (github.com/Mattabase/modlens-mcp)",
    ...(token ? { Authorization: token } : {}),
};

export interface ModrinthVersion {
    id: string;
    project_id: string;
    name: string;
    version_number: string;
    date_published: string;
    downloads: number;
    files: Array<{ url: string; filename: string; primary: boolean; hashes: { sha512: string; }; }>;
}

export interface ModrinthProject {
    id: string;
    slug: string;
    title: string;
    description: string;
    source_url: string | null;
    issues_url: string | null;
}

export async function lookupBySha512(sha512: string): Promise<ModrinthVersion | null> {
    const res = await fetchWithRetry(`${MODRINTH_BASE}/version_file/${sha512}?algorithm=sha512`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Modrinth lookup failed: ${res.status}`);
    return res.json() as Promise<ModrinthVersion>;
}

export async function getProject(projectId: string): Promise<ModrinthProject | null> {
    const res = await fetchWithRetry(`${MODRINTH_BASE}/project/${projectId}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Modrinth project fetch failed: ${res.status}`);
    return res.json() as Promise<ModrinthProject>;
}

export async function getLatestVersion(projectId: string, mcVersion?: string): Promise<ModrinthVersion | null> {
    const params = new URLSearchParams({ loaders: '["fabric","neoforge","forge","quilt"]' });
    if (mcVersion) params.set("game_versions", JSON.stringify([mcVersion]));
    const res = await fetchWithRetry(`${MODRINTH_BASE}/project/${projectId}/version?${params}`, { headers });
    if (!res.ok) return null;
    const versions = await res.json() as ModrinthVersion[];
    return versions[0] ?? null;
}
