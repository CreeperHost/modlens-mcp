import { modpacksChGet as get, packVersions, type PackMetadata, type PackManifest } from "./modpacks-ch.js";

export interface OfficialFtbPackSearchResult {
    packs: OfficialFtbPackSummary[] | number[];
    count?: number;
    total?: number;
    limit: number;
    updated?: number;
}

export type OfficialFtbPackSummary = Partial<PackMetadata> & {
    id: number;
    name: string;
    slug?: string;
    provider?: string;
    platform?: string;
    platform_deprecated?: boolean;
    updated?: number;
};

export type OfficialFtbPack = PackMetadata & {
    status?: string;
    slug?: string;
    released?: number;
    private?: boolean;
    featured?: boolean;
};

export type OfficialFtbManifest = Omit<PackManifest, "files"> & {
    status?: string;
    private?: boolean;
    changelog?: string;
    files: Array<Omit<PackManifest["files"][number], "mirror" | "curseforge"> & {
        mirrors?: string[];
        mirror?: string;
        hashes?: { sha1?: string; sha256?: string; sha512?: string };
        curseforge?: { project: number | string; file: number | string };
    }>;
};

export async function searchOfficialFtbPacks(
    term: string,
    limit = 20,
    detailed = true,
): Promise<OfficialFtbPackSearchResult | null> {
    const suffix = detailed ? "/detailed" : "";
    return get<OfficialFtbPackSearchResult>(
        `modpack/search/${limit}${suffix}?term=${encodeURIComponent(term)}`,
    );
}

export async function getOfficialFtbPack(packId: number): Promise<OfficialFtbPack | null> {
    const pack = await get<OfficialFtbPack>(`ftb/${packId}`);
    return pack ? { ...pack, versions: await packVersions("ftb", pack.id) } : null;
}

export async function getOfficialFtbPackManifest(
    packId: number,
    versionId: number,
): Promise<OfficialFtbManifest | null> {
    return get<OfficialFtbManifest>(`ftb/${packId}/${versionId}`);
}
