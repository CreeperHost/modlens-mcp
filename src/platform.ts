const PISTON_META = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const NEOFORGE_META = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
const FABRIC_API_META = "https://api.modrinth.com/v2/project/P7dR8mSH/version?game_versions=[%221.21.1%22,%221.21.4%22,%221.21.5%22,%221.20.6%22]&loaders=[%22fabric%22]";

export interface MCVersion {
    id: string;
    type: "release" | "snapshot" | "old_beta" | "old_alpha";
    releaseTime: string;
}

export interface NeoForgeVersion {
    version: string;
    mcVersion: string;
}

export interface FabricApiVersion {
    version: string;
    mcVersion: string;
    datePublished: string;
}

let mcCache: MCVersion[] | null = null;
let neoforgeCache: NeoForgeVersion[] | null = null;

export async function listMcVersions(type?: "release" | "snapshot" | "all"): Promise<MCVersion[]> {
    if (!mcCache) {
        const res = await fetch(PISTON_META);
        if (!res.ok) throw new Error(`Failed to fetch MC versions: ${res.status}`);
        const data = await res.json() as { versions: MCVersion[]; };
        mcCache = data.versions.filter(
            (v) => v.type !== "old_beta" && v.type !== "old_alpha" &&
                new Date(v.releaseTime) >= new Date("2019-04-23")
        );
    }
    if (!type || type === "all") return mcCache;
    if (type === "release") return mcCache.filter((v) => v.type === "release");
    return mcCache.filter((v) => v.type === "snapshot");
}

export async function listNeoForgeVersions(mcVersion?: string, limit = 20): Promise<NeoForgeVersion[]> {
    if (!neoforgeCache) {
        const res = await fetch(NEOFORGE_META);
        if (!res.ok) throw new Error(`Failed to fetch NeoForge versions: ${res.status}`);
        const data = await res.json() as { versions: string[] };
        // NeoForge versions look like "21.1.0", "21.1.1", etc. — leading number = MC major
        neoforgeCache = data.versions
            .filter((v) => /^\d+\.\d+\.\d+/.test(v))
            .map((v) => {
                const parts = v.split(".");
                const mcVersion = `1.${parts[0]}.${parts[1]}`;
                return { version: v, mcVersion };
            })
            .reverse(); // newest first
    }

    const filtered = mcVersion
        ? neoforgeCache.filter((v) => v.mcVersion === mcVersion || v.mcVersion.startsWith(mcVersion))
        : neoforgeCache;

    return filtered.slice(0, limit);
}

export async function listFabricApiVersions(mcVersion?: string, limit = 20): Promise<FabricApiVersion[]> {
    // Fabric API project on Modrinth: P7dR8mSH
    const url = mcVersion
        ? `https://api.modrinth.com/v2/project/P7dR8mSH/version?game_versions=%5B%22${encodeURIComponent(mcVersion)}%22%5D&loaders=%5B%22fabric%22%5D`
        : `https://api.modrinth.com/v2/project/P7dR8mSH/version?loaders=%5B%22fabric%22%5D`;

    const res = await fetch(url, { headers: { "User-Agent": "modlens-mcp/1.0" } });
    if (!res.ok) throw new Error(`Failed to fetch Fabric API versions: ${res.status}`);

    const versions = await res.json() as Array<{
        version_number: string;
        date_published: string;
        game_versions: string[];
    }>;

    return versions.slice(0, limit).map((v) => ({
        version: v.version_number,
        mcVersion: v.game_versions[0] ?? "unknown",
        datePublished: v.date_published,
    }));
}
