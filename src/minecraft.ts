/**
 * Vanilla Minecraft JAR download + version listing.
 * Adapted from mcsrc-mcp's mojang.ts — uses modlens's CACHE_ROOT.
 */
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { CACHE_ROOT, ensureDir, exists } from "./cache.js";
import { fetchWithRetry, DOWNLOAD_OPTS } from "./fetch-utils.js";
import { hasRetroMcpMappings, hasSrgMappings } from "./mappings.js";

const VERSIONS_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

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
        // Use the remapper's catalog so supported alpha/beta releases remain reachable.
        manifestCache = data.versions.filter(v => hasSrgMappings(v.id) || hasRetroMcpMappings(v.id)
            || (v.type !== "old_beta" && v.type !== "old_alpha" && Date.parse(v.releaseTime) >= Date.parse("2019-04-23")));
    }
    return includeSnapshots
        ? manifestCache
        : manifestCache.filter((v) => v.type === "release");
}

/** Paths under ~/.modlens-cache for vanilla MC assets. */
export const mcPaths = {
    jar:          (version: string) => join(CACHE_ROOT, "mc-jars", `${version}.jar`),
    index:        (version: string) => join(CACHE_ROOT, "mc-index", `${version}-named-v2.json`),
    decompiled:   (version: string) => join(CACHE_ROOT, "mc-decompiled-named", version),
    classFile:    (version: string, className: string) =>
        join(CACHE_ROOT, "mc-decompiled-named", version, `${className}.java`),
    priorityDecompiled: (version: string) => join(CACHE_ROOT, "mc-priority-named", version),
    priorityClassFile: (version: string, className: string) =>
        join(CACHE_ROOT, "mc-priority-named", version, `${className}.java`),
};

const jarDownloads = new Map<string, Promise<string>>();

/** Download the MC client JAR for a version if not cached, return local path. */
export async function getMcJarPath(version: string): Promise<string> {
    const existing = jarDownloads.get(version);
    if (existing) return existing;
    const download = downloadMcJar(version);
    jarDownloads.set(version, download);
    try { return await download; }
    finally { jarDownloads.delete(version); }
}

async function downloadMcJar(version: string): Promise<string> {
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
