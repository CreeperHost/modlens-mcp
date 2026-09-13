import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { CACHE_ROOT, ensureDir, exists } from "./cache.js";
import { fetchMcVersionList } from "./minecraft.js";
import { loaderVersions, providerVersions } from "./modpacks-ch.js";

const NEOFORGE_MAVEN = "https://maven.creeperhost.net/net/neoforged/neoforge";
const NEOFORGE_META = `${NEOFORGE_MAVEN}/maven-metadata.xml`;
const FORGE_MAVEN = "https://maven.creeperhost.net/net/minecraftforge/forge";
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

let neoforgeCache: NeoForgeVersion[] | null = null;
let forgeCache: ForgeVersion[] | null = null;

export async function listMcVersions(type?: "release" | "snapshot" | "all"): Promise<MCVersion[]> {
    const versions = (await fetchMcVersionList(true)).map(({ id, type, releaseTime }) => ({ id, type, releaseTime }));
    return !type || type === "all" ? versions : versions.filter(version => version.type === type);
}

export async function listNeoForgeVersions(mcVersion?: string, limit = 20): Promise<NeoForgeVersion[]> {
    if (mcVersion) return (await loaderVersions(mcVersion, "neoforge")).slice(0, limit)
        .map(v => ({ version: v.version, mcVersion: v.gameVersion ?? mcVersion }));
    if (!neoforgeCache) {
        const res = await fetch(NEOFORGE_META);
        if (!res.ok) throw new Error(`Failed to fetch NeoForge versions: ${res.status}`);
        const data = { versions: [...(await res.text()).matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]) };
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
    const versions = await providerVersions("mod", "P7dR8mSH", { mcVersion, loader: "fabric", limit });
    return versions.map((v) => ({
        version: v.version,
        mcVersion: (v.targets ?? []).find(t => t.type === "game")?.version ?? "unknown",
        datePublished: new Date((v.updated ?? 0) * 1000).toISOString(),
    }));
}

export async function listForgeVersions(mcVersion?: string, limit = 20): Promise<ForgeVersion[]> {
    if (mcVersion) return (await loaderVersions(mcVersion, "forge")).slice(0, limit)
        .map(v => ({ version: v.version, fullVersion: `${mcVersion}-${v.version}`, mcVersion: v.gameVersion ?? mcVersion }));
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

export function resolveForgeArtifactVersions(version: string, mcVersion?: string): string[] {
    let fullVersion = version;
    if (!version.includes("-")) {
        if (!mcVersion) throw new Error("Forge download requires either full version (e.g. 1.20.1-47.3.22) or version + mcVersion");
        fullVersion = `${mcVersion}-${version}`;
    }

    const candidates = [fullVersion];
    if (mcVersion && !fullVersion.endsWith(`-${mcVersion}`)) {
        candidates.push(`${fullVersion}-${mcVersion}`);
    }
    return candidates;
}

/**
 * Download the Forge universal JAR for a given version.
 * Version format: "1.20.1-47.3.22" (full artifact version) or just "47.3.22" with mcVersion.
 * Returns the local JAR path.
 */
export async function downloadForge(version: string, mcVersion?: string): Promise<string> {
    const errors: string[] = [];
    for (const artifactVersion of resolveForgeArtifactVersions(version, mcVersion)) {
        const destPath = join(CACHE_ROOT, "loaders", "forge", `forge-${artifactVersion}-universal.jar`);
        const url = `${FORGE_MAVEN}/${artifactVersion}/forge-${artifactVersion}-universal.jar`;
        try {
            return await downloadJar(url, destPath);
        } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }

    throw new Error(errors.join("; "));
}

/**
 * Download the Fabric API JAR for a given version from Modrinth.
 * Version format: "0.116.11+1.21.1".
 * Returns the local JAR path.
 */
export async function downloadFabricApi(version: string): Promise<string> {
    const destPath = join(CACHE_ROOT, "loaders", "fabric-api", `fabric-api-${version}.jar`);
    if (await exists(destPath)) return destPath;

    return downloadJar(`https://maven.creeperhost.net/net/fabricmc/fabric-api/fabric-api/${encodeURIComponent(version)}/fabric-api-${encodeURIComponent(version)}.jar`, destPath);
}
