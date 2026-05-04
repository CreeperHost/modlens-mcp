const PISTON_META = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

export interface MCVersion {
    id: string;
    type: "release" | "snapshot" | "old_beta" | "old_alpha";
    releaseTime: string;
}

let cache: MCVersion[] | null = null;

export async function listMcVersions(type?: "release" | "snapshot" | "all"): Promise<MCVersion[]> {
    if (!cache) {
        const res = await fetch(PISTON_META);
        if (!res.ok) throw new Error(`Failed to fetch MC versions: ${res.status}`);
        const data = await res.json() as { versions: MCVersion[]; };
        cache = data.versions.filter(
            (v) => v.type !== "old_beta" && v.type !== "old_alpha" &&
                new Date(v.releaseTime) >= new Date("2019-04-23")
        );
    }
    if (!type || type === "all") return cache;
    if (type === "release") return cache.filter((v) => v.type === "release");
    return cache.filter((v) => v.type === "snapshot");
}
