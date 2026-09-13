import { fetchWithRetry, safeJson } from "./fetch-utils.js";
import {
    getMod, modpacksChGet, providerVersions, providerSearch, providerLink, resolveModVersionUrl,
    type ModMetadata, type ModVersion,
} from "./modpacks-ch.js";
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
    loaderSource?: "jar";
    date_published: string;
    downloads: number;
    files: Array<{
        url: string;
        filename: string;
        primary: boolean;
        size?: number;
        file_type?: string | null;
        hashes: { sha512?: string; sha1?: string; };
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

export function asModrinthProject(project: ModMetadata, kind = "mod"): ModrinthProject {
    return {
        id: String(project.id),
        slug: project.slug ?? String(project.id),
        title: project.name,
        description: project.synopsis ?? "",
        project_type: kind,
        source_url: providerLink(project, "source") ?? providerLink(project, "github") ?? null,
        issues_url: providerLink(project, "issues") ?? null,
    };
}

export function asModrinthVersion(version: ModVersion, projectId: string): ModrinthVersion {
    const url = resolveModVersionUrl(version);
    return {
        id: String(version.id),
        project_id: projectId,
        name: version.name,
        version_number: version.version ?? version.name,
        version_type: version.type,
        date_published: new Date((version.updated ?? 0) * 1000).toISOString(),
        downloads: 0,
        game_versions: (version.targets ?? []).filter(target => target.type === "game").map(target => target.version),
        loaders: (version.targets ?? []).filter(target => target.type === "modloader").map(target => target.name),
        ...(version.loaderSource ? { loaderSource: version.loaderSource } : {}),
        files: url ? [{ url, filename: version.name, primary: true, size: version.size, hashes: { sha1: version.sha1 } }] : [],
    };
}

export async function getProject(projectId: string): Promise<ModrinthProject | null> {
    const p = await getMod(projectId);
    return p ? asModrinthProject(p) : null;
}
export async function lookupProjectByHash(hash: string): Promise<ModrinthProject | null> {
    const project = await getMod(hash);
    if (!project || (project.provider && project.provider !== "modrinth") || /^\d+$/.test(String(project.id))) return null;
    return asModrinthProject(project);
}
export async function getPackProject(projectId: string): Promise<ModrinthProject | null> {
    const p = await modpacksChGet<ModMetadata>(`modrinth/${encodeURIComponent(projectId)}`);
    return p ? asModrinthProject(p, "modpack") : null;
}

export async function getLatestVersion(projectId: string, mcVersion?: string, loader?: string): Promise<ModrinthVersion | null> {
    if (mcVersion && !/^\d+(?:\.\d+)*$/.test(mcVersion)) {
        const [version] = await providerVersions("mod", projectId, { loader, mcVersionRange: mcVersion, limit: 1 });
        return version ? asModrinthVersion(version, projectId) : null;
    }
    const rows = await getProjectVersions(projectId, { mcVersion, loader, limit: 1 });
    return rows[0] ?? null;
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
    loaderSource?: "jar";
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
export async function searchProjects(query: string, opts: {loader?: string; mcVersion?: string; limit?: number; projectType?: string} = {}): Promise<ModrinthSearchResult> {
    const kind = opts.projectType ?? "mod";
    if (kind !== "mod" && kind !== "modpack") throw new Error(`Unsupported modpacks.ch project type: ${kind}`);
    const rows = await providerSearch("modrinth", kind, query, opts);
    const hits: ModrinthSearchHit[] = rows.map(p => ({project_id:String(p.id), slug:p.slug ?? String(p.id), title:p.name,
        description:p.synopsis ?? "", categories:(p.tags ?? []).map(t=>t.name), downloads:p.installs ?? 0,
        follows:0, latest_version:"", versions:(p.targets ?? []).filter(t=>t.type==="game").map(t=>t.version),
        loaders:(p.targets ?? []).filter(t=>t.type==="modloader").map(t=>t.name),
        ...(p.loaderSource ? {loaderSource:p.loaderSource} : {}),
        date_modified:new Date((p.updated ?? 0)*1000).toISOString(), license:"", project_type:kind}));
    return {hits,offset:0,limit:opts.limit ?? 20,total_hits:hits.length};
}

export async function getProjectVersions(projectId: string, opts: {loader?: string; mcVersion?: string; limit?: number; pack?: boolean} = {}): Promise<ModrinthVersion[]> {
    return (await providerVersions(opts.pack ? "modrinth" : "mod", projectId, opts)).map(v=>asModrinthVersion(v,projectId));
}
export async function getPackVersions(projectId: string): Promise<ModrinthVersion[]> {
    return getProjectVersions(projectId, {pack:true});
}

export async function getProjectVersion(projectId: string, versionRef: string): Promise<ModrinthVersion | null> {
    return (await getProjectVersions(projectId)).find(v=>v.id===versionRef || v.version_number===versionRef) ?? null;
}
export async function getPackVersion(projectId: string, versionRef: string): Promise<ModrinthVersion | null> {
    return (await getPackVersions(projectId)).find(v=>v.id===versionRef || v.version_number===versionRef) ?? null;
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
    async lookup({ sha1 }) {
        if (!sha1) return null;
        const proj = await lookupProjectByHash(sha1);
        if (!proj) return null;
        return {
            platform: "modrinth" as const,
            projectId: proj.id,
            slug:      proj?.slug,
            sourceUrl: proj?.source_url,
        };
    },
};
