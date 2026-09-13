import { randomUUID } from "crypto";
import { createWriteStream } from "fs";
import { rename, unlink } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { CACHE_ROOT, ensureDir, exists } from "./cache.js";
import { DOWNLOAD_OPTS, fetchWithRetry } from "./fetch-utils.js";
import { resolveModVersionUrl, USER_AGENT, type ModVersion } from "./modpacks-ch.js";
import { fileSha1, validatePath } from "./security.js";

const downloads = new Map<string, Promise<string>>();

/** Share downloaded artifacts between metadata inspection and ingestion. */
export async function downloadModVersion(projectId: string | number, version: ModVersion, force = false): Promise<string> {
    const sha1 = version.sha1?.toLowerCase();
    if (sha1 && !/^[a-f0-9]{40}$/.test(sha1)) throw new Error(`Invalid SHA-1 for ${version.name}`);
    const directory = validatePath(String(projectId), join(CACHE_ROOT, "mods"));
    const destination = validatePath(`${sha1 || version.id}.jar`, directory);
    const pending = downloads.get(destination);
    if (pending) {
        if (!force) return pending;
        await pending;
        return downloadModVersion(projectId, version, true);
    }

    const download = async () => {
        if (!force && await exists(destination) && (!sha1 || await fileSha1(destination) === sha1)) return destination;
        const url = resolveModVersionUrl(version);
        if (!url) throw new Error(`No download URL available for ${version.name}`);
        await ensureDir(destination);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
            // Fetch errors can contain a URL with a configured download key.
            const response = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } }, DOWNLOAD_OPTS)
                .catch(() => { throw new Error(`Download failed for ${version.name}`); });
            if (!response.ok) throw new Error(`Download failed for ${version.name}: HTTP ${response.status}`);
            await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(temporary));
            if (sha1 && await fileSha1(temporary) !== sha1) throw new Error(`SHA-1 mismatch for ${version.name}`);
            await rename(temporary, destination);
            return destination;
        } finally {
            await unlink(temporary).catch(() => {});
        }
    };
    const task = download();
    downloads.set(destination, task);
    try {
        return await task;
    } finally {
        downloads.delete(destination);
    }
}
