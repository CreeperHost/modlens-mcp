import { homedir } from "os";
import { join } from "path";
import { mkdir, access } from "fs/promises";

/**
 * Root of the on-disk cache (decompiled source, downloaded tools/JARs, indexes).
 *
 * Resolution order:
 *   1. MODLENS_CACHE_ROOT — explicit override. The Docker image sets this to a
 *      path on the persistent /data volume.
 *   2. ~/.modlens-cache — default for local CLI / npx installs.
 *
 * Why the override matters in containers: os.homedir() resolves to "/" (or
 * another unwritable path) when the process runs as a non-root uid with no HOME,
 * which makes Vineflower fail with "Failed to save directory". Pointing the cache
 * at the mounted data volume fixes the permission error and lets expensive
 * decompiled output survive container restarts.
 */
export const CACHE_ROOT =
    process.env.MODLENS_CACHE_ROOT?.trim() || join(homedir(), ".modlens-cache");

export const paths = {
    jars: (key: string) => join(CACHE_ROOT, "jars", key),
    decompiled: (modId: string, version: string) =>
        join(CACHE_ROOT, "decompiled", modId, version),
    graphs: (modId: string, version: string) =>
        join(CACHE_ROOT, "graphs", modId, version),
    index: (jarPath: string) =>
        join(CACHE_ROOT, "index", sha256Path(jarPath) + ".json"),
    tools: join(CACHE_ROOT, "tools"),
    vineflower: join(CACHE_ROOT, "tools", "vineflower.jar"),
    indexerJar: join(CACHE_ROOT, "tools", "mcsrc-indexer.jar"),
    graphRegistry: join(CACHE_ROOT, "registries", "graph-index.json"),
    embedRegistry: join(CACHE_ROOT, "registries", "embed-index.json"),
    embedBundles: join(CACHE_ROOT, "embed-bundles"),
};

function sha256Path(s: string): string {
    // Simple deterministic key from jar path — just replace path separators
    return s.replace(/[\/\\:]/g, "_").replace(/\.jar$/, "");
}

export async function ensureDir(filePath: string): Promise<void> {
    const dir = filePath.endsWith("/") || filePath.endsWith("\\")
        ? filePath
        : join(filePath, "..");
    await mkdir(dir, { recursive: true });
}

export async function exists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}
