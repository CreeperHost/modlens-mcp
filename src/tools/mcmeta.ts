/**
 * MCP tools for misode/mcmeta — version-controlled Minecraft data & assets.
 *
 * Data URL pattern: https://raw.githubusercontent.com/misode/mcmeta/{version}-{branch}/{path}
 * Latest summary:   https://raw.githubusercontent.com/misode/mcmeta/summary/{path}
 *
 * Branches:
 *   summary      - blocks, commands, item_components, registries, sounds, versions
 *   registries   - one JSON file per registry key
 *   data         - vanilla datapack (namespaced JSON files)
 *   data-json    - data but JSON only
 *   assets       - vanilla resource pack
 *   assets-json  - assets but JSON only
 *   assets-tiny  - assets from JAR only (no sounds/languages)
 *   diff         - combination of assets+data+summary in diffable format
 *   atlas        - texture atlases for blocks/items/entities
 *
 * All fetched files are cached to ~/.modlens-cache/mcmeta/{version}/{branch}/...
 */
import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { join, dirname, extname } from "path";
import { CACHE_ROOT, exists, ensureDir } from "../cache.js";

// ── Cache ─────────────────────────────────────────────────────────────────────
const MCMETA_CACHE = join(CACHE_ROOT, "mcmeta");
const RAW_BASE     = "https://raw.githubusercontent.com/misode/mcmeta";

function mcmetaCachePath(version: string, branch: string, filePath: string): string {
    return join(MCMETA_CACHE, version, branch, filePath);
}

// ── Fetch + cache ─────────────────────────────────────────────────────────────
async function fetchMcmeta(
    ref: string,   // e.g. "summary" or "26.1.2-summary"
    filePath: string,
    binary = false,
): Promise<Buffer> {
    const url = `${RAW_BASE}/${ref}/${filePath}`;
    // derive cache path from ref
    const [version, branch] = ref.includes("-")
        ? ref.split(/-(.+)/) as [string, string]
        : ["_latest", ref];
    const cachePath = mcmetaCachePath(version, branch, filePath);

    if (await exists(cachePath)) {
        return readFile(cachePath);
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`mcmeta fetch failed: ${res.status} — ${url}`);
    const buf = binary
        ? Buffer.from(await res.arrayBuffer())
        : Buffer.from(await res.text());

    await ensureDir(cachePath);
    await writeFile(cachePath, buf);
    return buf;
}

async function fetchMcmetaJson<T>(ref: string, filePath: string): Promise<T> {
    const buf = await fetchMcmeta(ref, filePath, false);
    return JSON.parse(buf.toString("utf8")) as T;
}

/** Build the ref string for a specific MC version + branch. */
function versionRef(version: string | undefined, branch: string): string {
    return version ? `${version}-${branch}` : branch;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/** List all available Minecraft versions from the summary branch. */
export async function getMcmetaVersions(filter?: "release" | "snapshot" | "all"): Promise<object> {
    type McVersion = { id: string; type: string; stable: boolean; data_version: number; data_pack_version: number; resource_pack_version: number; release_time: string };
    const versions = await fetchMcmetaJson<McVersion[]>("summary", "versions/data.json");
    const filtered = (filter === "release")
        ? versions.filter(v => v.type === "release")
        : (filter === "snapshot")
            ? versions.filter(v => v.type === "snapshot")
            : versions;
    return { count: filtered.length, versions: filtered };
}

/** Get block state properties and defaults for a MC version. */
export async function getMcBlocks(version?: string): Promise<object> {
    const ref = versionRef(version, "summary");
    const data = await fetchMcmetaJson<unknown>(ref, "blocks/data.json");
    return { version: version ?? "latest", data };
}

/** Get the Brigadier command tree for a MC version. */
export async function getMcCommands(version?: string): Promise<object> {
    const ref = versionRef(version, "summary");
    const data = await fetchMcmetaJson<unknown>(ref, "commands/data.json");
    return { version: version ?? "latest", data };
}

/** Get registry list (summary) or a specific registry's entries. */
export async function getMcRegistries(version?: string, registry?: string): Promise<object> {
    const ref = versionRef(version, "summary");
    if (registry) {
        // Try the dedicated registries branch for specific registry data
        const regRef = versionRef(version, "registries");
        try {
            const data = await fetchMcmetaJson<unknown>(regRef, `${registry}.json`);
            return { version: version ?? "latest", registry, data };
        } catch {
            // Fall back to summary registries
            const summaryData = await fetchMcmetaJson<Record<string, unknown>>(ref, "registries/data.json");
            const entry = summaryData[registry] ?? summaryData[`minecraft:${registry}`];
            if (!entry) return { version: version ?? "latest", registry, found: false, availableKeys: Object.keys(summaryData) };
            return { version: version ?? "latest", registry, data: entry };
        }
    }
    const data = await fetchMcmetaJson<unknown>(ref, "registries/data.json");
    return { version: version ?? "latest", data };
}

/** Get sounds.json for a MC version. */
export async function getMcSounds(version?: string): Promise<object> {
    const ref = versionRef(version, "summary");
    const data = await fetchMcmetaJson<unknown>(ref, "sounds/data.json");
    return { version: version ?? "latest", data };
}

/** Get item component definitions for a MC version. */
export async function getMcItemComponents(version?: string): Promise<object> {
    const ref = versionRef(version, "summary");
    const data = await fetchMcmetaJson<unknown>(ref, "item_components/data.json");
    return { version: version ?? "latest", data };
}

/** Get or list files from the data/data-json branch (vanilla datapack). */
export async function getMcDataFile(
    filePath: string,
    version?: string,
    jsonOnly = false,
): Promise<object> {
    const branch = jsonOnly ? "data-json" : "data";
    const ref    = versionRef(version, branch);
    try {
        const buf  = await fetchMcmeta(ref, filePath, !filePath.endsWith(".json"));
        const isJson = filePath.endsWith(".json") || !buf.slice(0, 1).toString().match(/[^\x20-\x7e\t\n\r]/);
        return {
            version: version ?? "latest",
            branch,
            path: filePath,
            content: isJson ? JSON.parse(buf.toString("utf8")) : buf.toString("base64"),
            encoding: isJson ? "json" : "base64",
        };
    } catch (err) {
        return { version: version ?? "latest", branch, path: filePath, error: String(err) };
    }
}

/** Get or download a file from the assets branch. Binary files (png, ogg) return cached path. */
export async function getMcAssetFile(
    filePath: string,
    version?: string,
    jsonOnly = false,
): Promise<object> {
    const branch = jsonOnly ? "assets-json" : "assets";
    const ref    = versionRef(version, branch);
    const ext    = extname(filePath).toLowerCase();
    const isBinary = [".png", ".ogg", ".gif", ".wav"].includes(ext);

    try {
        const buf = await fetchMcmeta(ref, filePath, isBinary);
        if (isBinary) {
            const [ver, br] = ref.includes("-") ? ref.split(/-(.+)/) as [string, string] : ["_latest", ref];
            const cachePath = mcmetaCachePath(ver, br, filePath);
            return { version: version ?? "latest", branch, path: filePath, cachedAt: cachePath, encoding: "binary" };
        }
        const isJson = filePath.endsWith(".json");
        return {
            version: version ?? "latest",
            branch,
            path: filePath,
            content: isJson ? JSON.parse(buf.toString("utf8")) : buf.toString("utf8"),
        };
    } catch (err) {
        return { version: version ?? "latest", branch, path: filePath, error: String(err) };
    }
}

/** List files within a directory on a specific branch/version by reading cache or using the GitHub tree API. */
export async function listMcDataFiles(
    dirPath: string,
    version: string,
    branch: string,
): Promise<object> {
    // Try listing the local cache directory if it's already downloaded
    const cacheDir = mcmetaCachePath(version, branch, dirPath);
    if (await exists(cacheDir)) {
        try {
            const entries = await readdir(cacheDir, { withFileTypes: true });
            const files = entries.map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
            return { version, branch, path: dirPath, source: "cache", entries: files };
        } catch { /* fall through to API */ }
    }

    // Use GitHub API to list tree
    const apiUrl = `https://api.github.com/repos/misode/mcmeta/git/trees/${version}-${branch}?recursive=0`;
    try {
        const res = await fetch(apiUrl, { headers: { Accept: "application/vnd.github.v3+json" } });
        if (!res.ok) throw new Error(`GitHub API ${res.status}`);
        const tree = await res.json() as { tree: Array<{ path: string; type: string }> };
        const prefix = dirPath ? dirPath.replace(/\/?$/, "/") : "";
        const entries = tree.tree
            .filter(e => {
                if (!prefix) return !e.path.includes("/");
                if (!e.path.startsWith(prefix)) return false;
                const rel = e.path.slice(prefix.length);
                return !rel.includes("/");
            })
            .map(e => ({ name: e.path.replace(prefix, ""), type: e.type === "tree" ? "dir" : "file", fullPath: e.path }));
        return { version, branch, path: dirPath, source: "github-api", entries };
    } catch (err) {
        return { version, branch, path: dirPath, error: String(err) };
    }
}

/** Compare a data/asset file between two MC versions using the diff branch. */
export async function diffMcData(
    filePath: string,
    versionA: string,
    versionB: string,
    branch = "data",
): Promise<object> {
    const [rawA, rawB] = await Promise.allSettled([
        fetchMcmetaJson<unknown>(`${versionA}-${branch}`, filePath),
        fetchMcmetaJson<unknown>(`${versionB}-${branch}`, filePath),
    ]);

    const contentA = rawA.status === "fulfilled" ? rawA.value : { error: String((rawA as PromiseRejectedResult).reason) };
    const contentB = rawB.status === "fulfilled" ? rawB.value : { error: String((rawB as PromiseRejectedResult).reason) };

    return { filePath, branch, versionA, versionB, contentA, contentB };
}

/** Get texture atlas data from the atlas branch. */
export async function getMcAtlas(version?: string, atlas?: string): Promise<object> {
    const ref = versionRef(version, "atlas");
    if (atlas) {
        const path = atlas.includes(".") ? atlas : `${atlas}.json`;
        try {
            const data = await fetchMcmetaJson<unknown>(ref, path);
            return { version: version ?? "latest", atlas, data };
        } catch (err) {
            return { version: version ?? "latest", atlas, error: String(err) };
        }
    }
    // List available atlases from cache or GitHub API
    return listMcDataFiles("", version ?? "latest", "atlas");
}

/** Fetch any arbitrary file from mcmeta by specifying the full ref and path. */
export async function getMcmetaRaw(
    ref: string,
    filePath: string,
): Promise<object> {
    const ext = extname(filePath).toLowerCase();
    const isBinary = [".png", ".ogg", ".gif", ".wav", ".nbt", ".dat", ".mca", ".jar"].includes(ext);
    try {
        const buf = await fetchMcmeta(ref, filePath, isBinary);
        if (isBinary) {
            const [ver, br] = ref.includes("-") ? ref.split(/-(.+)/) as [string, string] : ["_latest", ref];
            const cachePath = mcmetaCachePath(ver, br, filePath);
            return { ref, path: filePath, cachedAt: cachePath, encoding: "binary", sizeBytes: buf.length };
        }
        const isJson = filePath.endsWith(".json");
        return {
            ref,
            path: filePath,
            content: isJson ? JSON.parse(buf.toString("utf8")) : buf.toString("utf8"),
        };
    } catch (err) {
        return { ref, path: filePath, error: String(err) };
    }
}

/** Get registry entries from the dedicated registries branch for a specific registry. */
export async function getRegistryEntries(registry: string, version?: string): Promise<object> {
    const ref = versionRef(version, "registries");
    // Registry path: e.g. "minecraft/block.json" or "block.json"
    const paths = [
        registry.includes(".json") ? registry : `${registry}.json`,
        registry.includes("/") ? registry : `minecraft/${registry}.json`,
    ];
    for (const p of paths) {
        try {
            const data = await fetchMcmetaJson<unknown>(ref, p);
            return { version: version ?? "latest", registry, path: p, data };
        } catch { continue; }
    }
    // Fall back to summary registries/data.json (same as getMcRegistries)
    try {
        const summaryRef = versionRef(version, "summary");
        const summaryData = await fetchMcmetaJson<Record<string, unknown>>(summaryRef, "registries/data.json");
        const entry = summaryData[registry] ?? summaryData[`minecraft:${registry}`];
        if (entry) return { version: version ?? "latest", registry, source: "summary", data: entry };
    } catch { /* ignore */ }
    return { version: version ?? "latest", registry, found: false, tried: paths };
}

// ── Version comparison & changelog ───────────────────────────────────────────

/**
 * Compare two Minecraft versions using the GitHub compare API on the given branch.
 * Returns the list of files added, modified, and removed between the two versions.
 * Results are cached to ~/.modlens-cache/mcmeta/compare/{versionA}..{versionB}/{branch}.json
 */
export async function compareVersions(
    versionA: string,
    versionB: string,
    branch = "diff",
): Promise<object> {
    const cacheFile = join(MCMETA_CACHE, "compare", `${versionA}..${versionB}`, `${branch}.json`);
    if (await exists(cacheFile)) {
        const cached = JSON.parse((await readFile(cacheFile)).toString("utf8"));
        return { ...cached, source: "cache" };
    }

    const tagA = `${versionA}-${branch}`;
    const tagB = `${versionB}-${branch}`;
    const url = `https://api.github.com/repos/misode/mcmeta/compare/${tagA}...${tagB}`;

    const res = await fetch(url, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (!res.ok) {
        return { error: `GitHub compare API returned ${res.status}`, url, versionA, versionB, branch };
    }

    type CompareFile = { filename: string; status: string; additions: number; deletions: number; changes: number };
    type CompareResponse = { status: string; ahead_by: number; behind_by: number; total_commits: number; files?: CompareFile[] };
    const data = await res.json() as CompareResponse;

    const result = {
        versionA,
        versionB,
        branch,
        status: data.status,
        ahead_by: data.ahead_by,
        behind_by: data.behind_by,
        total_commits: data.total_commits,
        files: (data.files ?? []).map((f: CompareFile) => ({
            path: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
        })),
        file_count: (data.files ?? []).length,
        note: (data.files ?? []).length >= 300 ? "GitHub API caps at 300 files — use listMcDataFiles for full tree" : undefined,
    };

    await ensureDir(cacheFile);
    await writeFile(cacheFile, JSON.stringify(result));
    return result;
}

/**
 * Get the list of files changed in a specific Minecraft version
 * by comparing it to its parent commit in the given branch.
 *
 * Uses the GitHub commits API to fetch the diff for the version's commit.
 * Results are cached to ~/.modlens-cache/mcmeta/changelog/{version}/{branch}.json
 */
export async function getVersionChangelog(
    version: string,
    branch = "diff",
): Promise<object> {
    const cacheFile = join(MCMETA_CACHE, "changelog", version, `${branch}.json`);
    if (await exists(cacheFile)) {
        const cached = JSON.parse((await readFile(cacheFile)).toString("utf8"));
        return { ...cached, source: "cache" };
    }

    const tag = `${version}-${branch}`;
    const url = `https://api.github.com/repos/misode/mcmeta/commits/${tag}`;

    const res = await fetch(url, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (!res.ok) {
        return { error: `GitHub commits API returned ${res.status}`, version, branch, tag };
    }

    type CommitFile = { filename: string; status: string; additions: number; deletions: number; changes: number };
    type CommitResponse = { sha: string; commit: { message: string; author: { date: string } }; files?: CommitFile[] };
    const data = await res.json() as CommitResponse;

    const result = {
        version,
        branch,
        sha: data.sha,
        message: data.commit?.message,
        date: data.commit?.author?.date,
        files: (data.files ?? []).map((f: CommitFile) => ({
            path: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
        })),
        file_count: (data.files ?? []).length,
    };

    await ensureDir(cacheFile);
    await writeFile(cacheFile, JSON.stringify(result));
    return result;
}
