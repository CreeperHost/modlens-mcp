/**
 * Vanilla Minecraft JAR download + version listing.
 * Adapted from mcsrc-mcp's mojang.ts — uses modlens's CACHE_ROOT.
 */
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { CACHE_ROOT, ensureDir, exists } from "./cache.js";
import { fetchWithRetry, DOWNLOAD_OPTS } from "./fetch-utils.js";

const VERSIONS_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/** Versions with SRG mappings that we explicitly support even before 1.14 */
export const LEGACY_SRG_VERSIONS = new Set([
    "1.7.2", "1.7.10",
    "1.8", "1.8.8", "1.8.9",
    "1.9", "1.9.2", "1.9.4",
    "1.10", "1.10.2",
    "1.11", "1.11.1", "1.11.2",
    "1.12", "1.12.1", "1.12.2",
    "1.13", "1.13.1", "1.13.2",
]);

/** Pre-1.7.10 release versions with RetroMCP Tiny v2 mappings */
export const LEGACY_RETROMCP_VERSIONS = new Set([
    "1.5.2",
    "1.2.5", "1.2.4", "1.2.3",
    "1.1",
    "1.0",
]);

export interface McVersionEntry {
    id: string;
    type: "release" | "snapshot" | "old_beta" | "old_alpha";
    url: string;
    releaseTime: string;
}

let manifestCache: McVersionEntry[] | null = null;

export async function fetchMcVersionList(includeSnapshots = false): Promise<McVersionEntry[]> {
    if (!manifestCache) {
        const res = await fetchWithRetry(VERSIONS_URL);
        if (!res.ok) throw new Error(`Failed to fetch MC version manifest: ${res.status}`);
        const data = await res.json() as { versions: McVersionEntry[] };
        // Filter to 1.14+ (mojmap era) plus legacy SRG versions (1.7.2–1.12.2) plus RetroMCP versions
        manifestCache = data.versions.filter(
            (v) => v.type !== "old_beta" && v.type !== "old_alpha" &&
                (new Date(v.releaseTime) >= new Date("2019-04-23") || LEGACY_SRG_VERSIONS.has(v.id) || LEGACY_RETROMCP_VERSIONS.has(v.id))
        );
    }
    return includeSnapshots
        ? manifestCache
        : manifestCache.filter((v) => v.type === "release");
}

/** Paths under ~/.modlens-cache for vanilla MC assets. */
export const mcPaths = {
    jar:          (version: string) => join(CACHE_ROOT, "mc-jars", `${version}.jar`),
    index:        (version: string) => join(CACHE_ROOT, "mc-index", `${version}.json`),
    decompiled:   (version: string) => join(CACHE_ROOT, "mc-decompiled", version),
    classFile:    (version: string, className: string) =>
        join(CACHE_ROOT, "mc-decompiled", version, `${className}.java`),
};

/** Download the MC client JAR for a version if not cached, return local path. */
export async function getMcJarPath(version: string): Promise<string> {
    const jarPath = mcPaths.jar(version);
    if (await exists(jarPath)) return jarPath;

    const versions = await fetchMcVersionList(true);
    const entry = versions.find((v) => v.id === version);
    if (!entry) throw new Error(`Unknown Minecraft version: ${version}. Use list_mc_versions to see valid IDs.`);

    const manifestRes = await fetchWithRetry(entry.url);
    if (!manifestRes.ok) throw new Error(`Failed to fetch manifest for ${version}: ${manifestRes.status}`);

    const manifest = await manifestRes.json() as {
        downloads: { client: { url: string } };
    };

    await ensureDir(jarPath);
    const jarRes = await fetchWithRetry(manifest.downloads.client.url, undefined, DOWNLOAD_OPTS);
    if (!jarRes.ok || !jarRes.body)
        throw new Error(`Failed to download MC JAR for ${version}: ${jarRes.status}`);

    await pipeline(jarRes.body as unknown as NodeJS.ReadableStream, createWriteStream(jarPath));
    return jarPath;
}
