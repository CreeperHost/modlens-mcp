import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { CACHE_ROOT, ensureDir, exists } from "./cache.js";

const PISTON_META = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const NEOFORGE_META = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

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

async function downloadJar(url: string, destPath: string): Promise<string> {
    await ensureDir(destPath);
    if (await exists(destPath)) return destPath;
    const res = await fetch(url, { headers: { "User-Agent": "modlens-mcp/1.0" } });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const writer = createWriteStream(destPath);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
    return destPath;
}

/**
 * Download the NeoForge universal JAR for a given version.
 * Version format: "21.1.228" (maps to MC 1.21.1).
 * Returns the local JAR path.
 */
export async function downloadNeoForge(version: string): Promise<string> {
    const destPath = join(CACHE_ROOT, "loaders", "neoforge", `neoforge-${version}-universal.jar`);
    const url = `${NEOFORGE_MAVEN}/${version}/neoforge-${version}-universal.jar`;
    return downloadJar(url, destPath);
}

/**
 * Download the Fabric API JAR for a given version from Modrinth.
 * Version format: "0.116.11+1.21.1".
 * Returns the local JAR path.
 */
export async function downloadFabricApi(version: string): Promise<string> {
    const destPath = join(CACHE_ROOT, "loaders", "fabric-api", `fabric-api-${version}.jar`);
    if (await exists(destPath)) return destPath;

    // Fetch the version file list from Modrinth
    const res = await fetch(
        `https://api.modrinth.com/v2/project/P7dR8mSH/version?loaders=%5B%22fabric%22%5D`,
        { headers: { "User-Agent": "modlens-mcp/1.0" } }
    );
    if (!res.ok) throw new Error(`Modrinth lookup failed: ${res.status}`);

    const versions = await res.json() as Array<{
        version_number: string;
        files: Array<{ url: string; primary: boolean; filename: string }>;
    }>;

    const match = versions.find((v) => v.version_number === version);
    if (!match) throw new Error(`Fabric API version "${version}" not found on Modrinth`);

    const file = match.files.find((f) => f.primary) ?? match.files[0];
    if (!file) throw new Error(`No download file found for Fabric API ${version}`);

    return downloadJar(file.url, destPath);
}
