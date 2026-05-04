import { homedir } from "os";
import { join } from "path";
import { mkdir, access } from "fs/promises";

export const CACHE_ROOT = join(homedir(), ".modlens-cache");

export const paths = {
    jars: (key: string) => join(CACHE_ROOT, "jars", key),
    decompiled: (modId: string, version: string) =>
        join(CACHE_ROOT, "decompiled", modId, version),
    index: (jarPath: string) =>
        join(CACHE_ROOT, "index", sha256Path(jarPath) + ".json"),
    tools: join(CACHE_ROOT, "tools"),
    vineflower: join(CACHE_ROOT, "tools", "vineflower.jar"),
    indexerJar: join(CACHE_ROOT, "tools", "mcsrc-indexer.jar"),
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
