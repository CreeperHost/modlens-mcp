import { fetchWithRetry } from "./fetch-utils.js";
import { USER_AGENT, type FtbPack, type FtbManifest } from "./modpacks-ch.js";

const FTB_OFFICIAL_BASE = "https://api.feed-the-beast.com/v1/modpacks";
const HEADERS = { "User-Agent": USER_AGENT };

export interface OfficialFtbPackSearchResult {
    packs: OfficialFtbPackSummary[] | number[];
    count?: number;
    total?: number;
    limit: number;
    updated?: number;
}

export type OfficialFtbPackSummary = Partial<FtbPack> & {
    id: number;
    name: string;
    slug?: string;
    provider?: string;
    platform?: string;
    platform_deprecated?: boolean;
    updated?: number;
};

export type OfficialFtbPack = FtbPack & {
    status?: string;
    slug?: string;
    released?: number;
    private?: boolean;
    featured?: boolean;
};

export type OfficialFtbManifest = Omit<FtbManifest, "files"> & {
    status?: string;
    private?: boolean;
    changelog?: string;
    files: Array<Omit<FtbManifest["files"][number], "mirror" | "curseforge"> & {
        mirrors?: string[];
        mirror?: string;
        hashes?: { sha1?: string; sha256?: string; sha512?: string };
        curseforge?: { project: number | string; file: number | string };
    }>;
};

async function get<T>(path: string): Promise<T | null> {
    const res = await fetchWithRetry(`${FTB_OFFICIAL_BASE}/${path}`, { headers: HEADERS });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Feed The Beast API ${res.status} for /${path}`);
    const text = await res.text();
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`Feed The Beast API returned non-JSON for /${path}: ${text.slice(0, 200)}`);
    }
}

export async function searchOfficialFtbPacks(
    term: string,
    limit = 20,
    detailed = true,
): Promise<OfficialFtbPackSearchResult | null> {
    const suffix = detailed ? "/detailed/" : "";
    return get<OfficialFtbPackSearchResult>(
        `modpack/search/${limit}${suffix}?term=${encodeURIComponent(term)}`,
    );
}

export async function getOfficialFtbPack(packId: number): Promise<OfficialFtbPack | null> {
    return get<OfficialFtbPack>(`modpack/${packId}`);
}

export async function getOfficialFtbPackManifest(
    packId: number,
    versionId: number,
): Promise<OfficialFtbManifest | null> {
    return get<OfficialFtbManifest>(`modpack/${packId}/${versionId}`);
}
