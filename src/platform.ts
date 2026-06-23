import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { CACHE_ROOT, ensureDir, exists } from "./cache.js";
import { LEGACY_SRG_VERSIONS, LEGACY_RETROMCP_VERSIONS } from "./minecraft.js";

const PISTON_META = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const NEOFORGE_META = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FORGE_PROMOS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

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

export interface ForgeVersion {
    /** Full artifact version, e.g. "1.20.1-47.3.22" */
    fullVersion: string;
    /** Forge build version, e.g. "47.3.22" */
    version: string;
    /** Minecraft version, e.g. "1.20.1" */
    mcVersion: string;
    /** Whether this is the recommended build */
    recommended?: boolean;
}

let mcCache: MCVersion[] | null = null;
let neoforgeCache: NeoForgeVersion[] | null = null;
let forgeCache: ForgeVersion[] | null = null;

export async function listMcVersions(type?: "release" | "snapshot" | "all"): Promise<MCVersion[]> {
    if (!mcCache) {
        const res = await fetch(PISTON_META);
        if (!res.ok) throw new Error(`Failed to fetch MC versions: ${res.status}`);
        const data = await res.json() as { versions: MCVersion[]; };
        mcCache = data.versions.filter(
            (v) => v.type !== "old_beta" && v.type !== "old_alpha" &&
                (new Date(v.releaseTime) >= new Date("2019-04-23") || LEGACY_SRG_VERSIONS.has(v.id) || LEGACY_RETROMCP_VERSIONS.has(v.id))
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
        const data = await res.json() as { versions: string[]; };
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

    // Exact MC version, or a version-segment prefix family (e.g. "1.21" → all
    // "1.21.x"). The trailing "." prevents "1.21.1" from matching "1.21.11".
    const filtered = mcVersion
        ? neoforgeCache.filter((v) => v.mcVersion === mcVersion || v.mcVersion.startsWith(mcVersion + "."))
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

export async function listForgeVersions(mcVersion?: string, limit = 20): Promise<ForgeVersion[]> {
    if (!forgeCache) {
        // Fetch promotions to know which versions are recommended
        const promoRes = await fetch(FORGE_PROMOS, { headers: { "User-Agent": "modlens-mcp/1.0" } });
        const recommendedSet = new Set<string>();
        if (promoRes.ok) {
            const promoData = await promoRes.json() as { promos: Record<string, string> };
            for (const [key, ver] of Object.entries(promoData.promos)) {
                if (key.endsWith("-recommended")) {
                    const mc = key.replace("-recommended", "");
                    recommendedSet.add(`${mc}-${ver}`);
                }
            }
        }

        // Fetch Maven metadata for full version list
        const metaRes = await fetch(`${FORGE_MAVEN}/maven-metadata.xml`, { headers: { "User-Agent": "modlens-mcp/1.0" } });
        if (!metaRes.ok) throw new Error(`Failed to fetch Forge versions: ${metaRes.status}`);
        const xml = await metaRes.text();

        // Parse <version> tags from XML
        const versionRegex = /<version>([^<]+)<\/version>/g;
        const allVersions: ForgeVersion[] = [];
        let match: RegExpExecArray | null;
        while ((match = versionRegex.exec(xml)) !== null) {
            const fullVersion = match[1];
            // Format: "mcVersion-forgeVersion" (e.g. "1.20.1-47.3.22")
            // Some old ones: "1.7.10-10.13.4.1614-1.7.10" (MC version appended twice)
            const dashIdx = fullVersion.indexOf("-");
            if (dashIdx === -1) continue;
            const mc = fullVersion.substring(0, dashIdx);
            // Strip trailing "-mcVersion" suffix from old Forge versions
            let forgeVer = fullVersion.substring(dashIdx + 1);
            if (forgeVer.endsWith(`-${mc}`)) {
                forgeVer = forgeVer.substring(0, forgeVer.length - mc.length - 1);
            }
            allVersions.push({
                fullVersion,
                version: forgeVer,
                mcVersion: mc,
                recommended: recommendedSet.has(fullVersion),
            });
        }
        forgeCache = allVersions.reverse(); // newest first
    }

    // Exact MC version, or a version-segment prefix family (e.g. "1.21" → all
    // "1.21.x"). The trailing "." prevents "1.21.1" from matching "1.21.11".
    const filtered = mcVersion
        ? forgeCache.filter((v) => v.mcVersion === mcVersion || v.mcVersion.startsWith(mcVersion + "."))
        : forgeCache;

    return filtered.slice(0, limit);
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
 * Download the Forge universal JAR for a given version.
 * Version format: "1.20.1-47.3.22" (full artifact version) or just "47.3.22" with mcVersion.
 * Returns the local JAR path.
 */
export async function downloadForge(version: string, mcVersion?: string): Promise<string> {
    let fullVersion = version;
    // If user only provided the Forge build number (no dash), we need mcVersion to construct the full version
    if (!version.includes("-")) {
        if (!mcVersion) throw new Error("Forge download requires either full version (e.g. 1.20.1-47.3.22) or version + mcVersion");
        fullVersion = `${mcVersion}-${version}`;
    }
    const destPath = join(CACHE_ROOT, "loaders", "forge", `forge-${fullVersion}-universal.jar`);
    const url = `${FORGE_MAVEN}/${fullVersion}/forge-${fullVersion}-universal.jar`;
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
        files: Array<{ url: string; primary: boolean; filename: string; }>;
    }>;

    const match = versions.find((v) => v.version_number === version);
    if (!match) throw new Error(`Fabric API version "${version}" not found on Modrinth`);

    const file = match.files.find((f) => f.primary) ?? match.files[0];
    if (!file) throw new Error(`No download file found for Fabric API ${version}`);

    return downloadJar(file.url, destPath);
}
