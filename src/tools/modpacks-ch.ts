/**
 * modpacks.ch tool — search and sync packs from both the FTB and
 * CurseForge namespaces exposed by the modpacks.ch public API (no API key
 * required for either).
 *
 * modpacks.ch is a service by CreeperHost (https://www.creeperhost.net).
 * Thanks to CreeperHost for providing this free public API.
 *
 * User-Agent spec: The modpacks.ch team requested a custom User-Agent for
 * usage tracking.  See USER_AGENT constant in src/modpacks-ch.ts.
 *
 * Supported actions:
 *   search          — full-text search FTB or CurseForge packs
 *   featured        — list featured FTB packs
 *   info            — get pack metadata + version list
 *   manifest        — get the full file manifest for a specific version
 *   sync_pack_mods  — download + ingest every mod/datapack/resourcepack JAR
 *                     from a pack version's manifest into the ModLens DB
 *   search_ftb_mods — search the FTB mod index (returns mixed CF int / MR
 *                     string IDs)
 */
import { basename, extname, join, resolve, sep } from "path";
import { createHash } from "crypto";
import { rename, mkdir, unlink } from "fs/promises";
import AdmZip from "adm-zip";
import { ensureDir, exists, CACHE_ROOT } from "../cache.js";
import {
    searchPacks, getFeaturedPacks, getPack, getPackManifest,
    getCfPack, getCfPackManifest,
    searchMods, getMod, getModsBatch, resolveModVersionUrl,
    USER_AGENT, cfCdnUrl,
    downloadManifestFile, resolveFileUrl,
    type FtbManifest, type FtbManifestFile, type FtbModVersion, type FtbPack,
} from "../modpacks-ch.js";
import { fetchWithRetry, DOWNLOAD_OPTS } from "../fetch-utils.js";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import {
    searchProjects as searchModrinthProjects,
    getProject as getModrinthProject,
    getProjectVersions as getModrinthProjectVersions,
    getProjectVersion as getModrinthProjectVersion,
    getVersion as getModrinthVersion,
    getPrimaryFile as getModrinthPrimaryFile,
    type ModrinthProject,
    type ModrinthSearchHit,
    type ModrinthVersion,
} from "../modrinth.js";
import {
    searchOfficialFtbPacks,
    getOfficialFtbPack,
    getOfficialFtbPackManifest,
    type OfficialFtbPack,
    type OfficialFtbManifest,
    type OfficialFtbPackSummary,
} from "../feed-the-beast.js";

const MOD_HEADERS = { "User-Agent": USER_AGENT };
import { ingestMod } from "./ingest.js";
import {
    upsertPackVersion, upsertPackFile,
    listPackVersions, listPackFiles,
    findPacksForMod, findPacksForCfProject, findPackVersion,
} from "../repositories/packs.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type PackNamespace = "ftb" | "curseforge" | "modrinth" | "feedthebeast";

export interface SyncPackModsOptions {
    packId:      number;
    versionId:   number;
    namespace:   Exclude<PackNamespace, "modrinth">;
    packName?:   string;
    versionName?: string;
    /** Only ingest files matching these types (default: ["mod", "resource"]). */
    fileTypes?:  string[];
    /** Skip files that are server-only (default: false). */
    skipServer?: boolean;
    /** Skip optional files (default: false). */
    skipOptional?: boolean;
    /** Maximum number of mods to ingest concurrently (default: 3). */
    concurrency?: number;
    /** Limit files processed for smoke tests or sampling. */
    maxFiles?: number;
}

export interface IngestPackOptions {
    namespace?: PackNamespace;
    packId?: number | string;
    packRef?: number | string;
    versionId?: number | string;
    versionRef?: number | string;
    fileTypes?: string[];
    skipServer?: boolean;
    skipOptional?: boolean;
    concurrency?: number;
    maxFiles?: number;
}

interface FileResult {
    name:      string;
    type:      string;
    fileId?:   number;  // manifest file id (file.id from modpacks.ch API)
    status:    string;
    dbId?:     number;
    message?:  string;
}

interface ResolvedPackVersion {
    namespace: PackNamespace;
    packId: number;
    versionId: number;
    packName: string;
    versionName: string;
    mcVersion?: string | null;
    loader?: string | null;
    sourcePackId?: string | number;
    sourceVersionId?: string | number;
}

interface ModrinthIndexFile {
    path: string;
    hashes?: { sha1?: string; sha512?: string };
    env?: { client?: string; server?: string };
    downloads: string[];
    fileSize?: number;
}

interface ModrinthPackIndex {
    name: string;
    versionId: string;
    summary?: string;
    files: ModrinthIndexFile[];
    dependencies: Record<string, string>;
}

interface DownloadablePackFile {
    id: number;
    name: string;
    type: string;
    path: string;
    url: string;
    sha1?: string | null;
    serveronly?: boolean;
    optional?: boolean;
}

// ── Pack search / browse ──────────────────────────────────────────────────────

export async function searchPacksAction(term: string, namespace: PackNamespace = "ftb", limit = 20) {
    if (namespace === "modrinth") {
        const r = await searchModrinthProjects(term, { projectType: "modpack", limit });
        return {
            modrinthPacks: (r?.hits ?? []).map((h) => ({
                id: h.project_id,
                slug: h.slug,
                name: h.title,
                description: h.description,
                downloads: h.downloads,
                versions: h.versions,
                loaders: h.loaders,
                url: `https://modrinth.com/modpack/${h.slug}`,
            })),
            total: r?.total_hits ?? 0,
        };
    }
    if (namespace === "feedthebeast") {
        const r = await searchOfficialFtbPacks(term, limit, true);
        const packs = (r?.packs ?? []).filter((p): p is OfficialFtbPackSummary => typeof p === "object");
        return {
            feedTheBeastPacks: packs.map((p) => ({
                id: p.id,
                slug: p.slug,
                name: p.name,
                synopsis: p.synopsis,
                provider: p.provider,
                platform: p.platform,
                updated: p.updated ? new Date(p.updated * 1000).toISOString() : null,
                url: `https://www.feed-the-beast.com/modpacks/${p.id}`,
            })),
            total: r?.count ?? r?.total ?? packs.length,
            note: "Official Feed The Beast API results. Use namespace=feedthebeast for info/list_versions/ingest_pack.",
        };
    }

    // Always call the unified FTB search endpoint — it returns both FTB pack IDs
    // (in `packs`) and CurseForge pack IDs (in `curseforge`) in a single response.
    // The /curseforge/search/ endpoint does not exist.
    const r = await searchPacks(term, limit);
    if (!r) return { ftbPacks: [], cfPacks: [], total: 0 };
    const ftbPacks = r.packs        ?? [];
    const cfPacks  = r.curseforge   ?? [];
    // If caller specified a namespace, surface only that subset (but always
    // include both for discoverability — callers can filter as needed).
    return {
        ftbPacks,
        cfPacks,
        total:   r.total,
        note:    "ftbPacks = FTB-hosted; cfPacks = CurseForge-hosted (use namespace=curseforge for info/manifest)",
    };
}

export async function featuredPacksAction(limit = 20) {
    const r = await getFeaturedPacks(limit);
    if (!r) return { packs: [], total: 0 };
    return r;
}

function normalized(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hashToInt(value: string): number {
    return parseInt(createHash("sha1").update(value).digest("hex").slice(0, 7), 16);
}

function maybeNumber(value: string | number | undefined): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    return undefined;
}

function parseModrinthWebRef(packRef: string | number | undefined, versionRef?: string | number): {
    packRef?: string | number;
    versionRef?: string | number;
    mrpackUrl?: string;
    versionIdOnly?: string;
} {
    if (typeof packRef !== "string") return { packRef, versionRef };
    let url: URL;
    try {
        url = new URL(packRef);
    } catch {
        return { packRef, versionRef };
    }

    if (url.protocol !== "https:") {
        throw new Error(`Modrinth pack URL must use HTTPS: ${packRef}`);
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.pathname.toLowerCase().endsWith(".mrpack")) {
        const cdnData = host === "cdn.modrinth.com" && parts[0] === "data" && parts[2] === "versions"
            ? { packRef: parts[1], versionRef: versionRef ?? parts[3] }
            : {};
        return { ...cdnData, mrpackUrl: url.toString() };
    }

    if (host === "modrinth.com") {
        const packIdx = parts.indexOf("modpack");
        if (packIdx >= 0 && parts[packIdx + 1]) {
            const parsedVersion = parts[packIdx + 2] === "version" ? parts[packIdx + 3] : undefined;
            return { packRef: parts[packIdx + 1], versionRef: versionRef ?? parsedVersion };
        }
    }

    if (host === "api.modrinth.com") {
        const projectIdx = parts.indexOf("project");
        if (projectIdx >= 0 && parts[projectIdx + 1]) {
            const parsedVersion = parts[projectIdx + 2] === "version" ? parts[projectIdx + 3] : undefined;
            return { packRef: parts[projectIdx + 1], versionRef: versionRef ?? parsedVersion };
        }
        const versionIdx = parts.indexOf("version");
        if (versionIdx >= 0 && parts[versionIdx + 1]) {
            return { versionRef: versionRef ?? parts[versionIdx + 1], versionIdOnly: parts[versionIdx + 1] };
        }
    }

    return { packRef, versionRef };
}

function modrinthInternalPackId(projectId: string): number {
    return hashToInt(`modrinth:project:${projectId}`);
}

function modrinthInternalVersionId(versionId: string): number {
    return hashToInt(`modrinth:version:${versionId}`);
}

function pickModrinthLoader(deps: Record<string, string>, loaders?: string[]): string | null {
    if (deps.neoforge) return "neoforge";
    if (deps.forge) return "forge";
    if (deps["fabric-loader"]) return "fabric";
    if (deps["quilt-loader"]) return "quilt";
    return loaders?.find((l) => l !== "minecraft") ?? null;
}

function classifyModrinthPath(path: string): string {
    const p = path.replace(/\\/g, "/").toLowerCase();
    if (p.startsWith("mods/") && p.endsWith(".jar")) return "mod";
    if (p.startsWith("resourcepacks/")) return "resource";
    if (p.startsWith("datapacks/")) return "resource";
    if (p.startsWith("config/") || p.startsWith("defaultconfigs/")) return "config";
    if (p.startsWith("kubejs/") || p.startsWith("scripts/")) return "script";
    return "override";
}

function resolveVersionByRef<T extends { id: number | string; name: string; version?: string; version_number?: string }>(
    versions: T[],
    ref?: number | string,
): T {
    if (versions.length === 0) throw new Error("Pack has no versions");
    if (ref === undefined || ref === "") return versions[0];

    const numeric = maybeNumber(ref);
    if (numeric !== undefined) {
        const hit = versions.find((v) => typeof v.id === "number" && v.id === numeric);
        if (hit) return hit;
    }

    const wanted = normalized(String(ref));
    const hit = versions.find((v) =>
        normalized(String(v.id)) === wanted ||
        normalized(v.name) === wanted ||
        (v.version !== undefined && normalized(v.version) === wanted) ||
        (v.version_number !== undefined && normalized(v.version_number) === wanted)
    );
    if (hit) return hit;

    const partialMatches = versions.filter((v) =>
        normalized(v.name).includes(wanted) ||
        (v.version !== undefined && normalized(v.version).includes(wanted)) ||
        (v.version_number !== undefined && normalized(v.version_number).includes(wanted))
    );
    if (partialMatches.length === 1) return partialMatches[0];
    if (partialMatches.length > 1) {
        const examples = partialMatches.slice(0, 8).map((v) => `${v.name} (${String(v.id)})`).join(", ");
        throw new Error(`Version "${String(ref)}" is ambiguous. Matching versions: ${examples}`);
    }

    {
        const examples = versions.slice(0, 8).map((v) => `${v.name} (${String(v.id)})`).join(", ");
        throw new Error(`Version "${String(ref)}" not found. Available examples: ${examples}`);
    }
}

function versionMatchesRef(version: { id: number | string; name: string; version?: string; version_number?: string }, ref?: number | string): boolean {
    if (ref === undefined || ref === "") return false;
    const wanted = normalized(String(ref));
    return normalized(String(version.id)) === wanted ||
        normalized(version.name) === wanted ||
        normalized(version.name).includes(wanted) ||
        (version.version !== undefined && normalized(version.version).includes(wanted)) ||
        (version.version_number !== undefined && normalized(version.version_number).includes(wanted));
}

async function resolveModpacksChPack(namespace: "ftb" | "curseforge", rawPackRef: number | string | undefined): Promise<FtbPack> {
    let packId = maybeNumber(rawPackRef);

    if (packId === undefined) {
        if (rawPackRef === undefined) throw new Error("Provide packId, packRef, or a pack name");
        const search = await searchPacks(String(rawPackRef), 20);
        const ids = namespace === "curseforge" ? (search?.curseforge ?? []) : (search?.packs ?? []);
        if (ids.length === 0) throw new Error(`No ${namespace} pack found for "${String(rawPackRef)}"`);
        const packs = (await Promise.all(ids.slice(0, 10).map((id) =>
            (namespace === "curseforge" ? getCfPack(id) : getPack(id)).catch(() => null)
        ))).filter((p): p is FtbPack => p !== null);
        const wanted = normalized(String(rawPackRef));
        const scored = packs
            .map((pack) => {
                const name = normalized(pack.name);
                const score = name === wanted ? 0 : name.includes(wanted) ? 1 : wanted.includes(name) ? 2 : 3;
                return { pack, score };
            })
            .sort((a, b) => a.score - b.score || b.pack.installs - a.pack.installs);
        packId = scored[0]?.pack.id ?? ids[0];
    }

    const pack = namespace === "curseforge" ? await getCfPack(packId) : await getPack(packId);
    if (!pack) throw new Error(`Pack ${packId} not found on namespace "${namespace}"`);
    return pack;
}

function normalizeOfficialFtbManifest(manifest: OfficialFtbManifest): FtbManifest {
    return {
        id: manifest.id,
        parent: manifest.parent,
        name: manifest.name,
        type: manifest.type,
        version: manifest.version ?? manifest.name,
        targets: manifest.targets ?? [],
        specs: manifest.specs,
        installs: manifest.installs ?? 0,
        plays: manifest.plays ?? 0,
        updated: manifest.updated ?? 0,
        refreshed: manifest.refreshed ?? 0,
        status: manifest.status ?? "success",
        files: (manifest.files ?? []).map((f) => {
            const cfProject = Number(f.curseforge?.project);
            const cfFile = Number(f.curseforge?.file);
            return {
                id: f.id,
                name: f.name,
                type: f.type,
                path: f.path,
                url: f.url,
                mirror: f.mirror ?? f.mirrors?.[0] ?? "",
                sha1: f.sha1 ?? f.hashes?.sha1 ?? "",
                size: f.size,
                clientonly: f.clientonly,
                serveronly: f.serveronly,
                optional: f.optional,
                tags: f.tags ?? [],
                curseforge: Number.isFinite(cfProject) && Number.isFinite(cfFile)
                    ? { project: cfProject, file: cfFile }
                    : undefined,
            };
        }),
    };
}

async function resolveOfficialFtbPack(rawPackRef: number | string | undefined): Promise<OfficialFtbPack> {
    let packId = maybeNumber(rawPackRef);

    if (packId === undefined) {
        if (rawPackRef === undefined) throw new Error("Provide packId, packRef, or a pack name");
        const search = await searchOfficialFtbPacks(String(rawPackRef), 20, true);
        const packs = (search?.packs ?? []).filter((p): p is OfficialFtbPackSummary => typeof p === "object");
        if (packs.length === 0) throw new Error(`No official Feed The Beast pack found for "${String(rawPackRef)}"`);
        const wanted = normalized(String(rawPackRef));
        const scored = packs
            .map((pack) => {
                const name = normalized(pack.name);
                const slug = normalized(pack.slug ?? "");
                const score = name === wanted || slug === wanted ? 0 :
                    name.includes(wanted) || slug.includes(wanted) ? 1 :
                    wanted.includes(name) ? 2 : 3;
                return { pack, score };
            })
            .sort((a, b) => a.score - b.score || (b.pack.installs ?? 0) - (a.pack.installs ?? 0));
        packId = scored[0]?.pack.id;
    }

    if (packId === undefined) throw new Error(`No official Feed The Beast pack found for "${String(rawPackRef)}"`);
    const pack = await getOfficialFtbPack(packId);
    if (!pack) throw new Error(`Official Feed The Beast pack ${packId} not found`);
    return pack;
}

async function resolveOfficialFtbPackVersion(opts: IngestPackOptions): Promise<ResolvedPackVersion> {
    const rawPackRef = opts.packId ?? opts.packRef;
    const rawVersionRef = opts.versionId ?? opts.versionRef;
    const pack = await resolveOfficialFtbPack(rawPackRef);
    const version = resolveVersionByRef(pack.versions ?? [], rawVersionRef);
    return {
        namespace: "feedthebeast",
        packId: pack.id,
        versionId: version.id,
        packName: pack.name,
        versionName: version.name,
        mcVersion: version.targets.find((t) => t.type === "game" || t.name === "minecraft")?.version ?? null,
        loader: version.targets.find((t) => t.type === "modloader")?.name ?? null,
        sourcePackId: pack.id,
        sourceVersionId: version.id,
    };
}

async function resolveModpacksChPackVersion(opts: IngestPackOptions): Promise<ResolvedPackVersion> {
    const namespace = opts.namespace === "curseforge" ? "curseforge" : "ftb";
    const rawPackRef = opts.packId ?? opts.packRef;
    const rawVersionRef = opts.versionId ?? opts.versionRef;
    const pack = await resolveModpacksChPack(namespace, rawPackRef);

    const version = resolveVersionByRef(pack.versions ?? [], rawVersionRef);
    return {
        namespace,
        packId: pack.id,
        versionId: version.id,
        packName: pack.name,
        versionName: version.name,
        mcVersion: version.targets.find((t) => t.type === "game" || t.name === "minecraft")?.version ?? null,
        loader: version.targets.find((t) => t.type === "modloader")?.name ?? null,
        sourcePackId: pack.id,
        sourceVersionId: version.id,
    };
}

export async function listRemotePackVersionsAction(opts: IngestPackOptions) {
    const namespace = opts.namespace ?? "ftb";
    const versionRef = opts.versionId ?? opts.versionRef;
    if (namespace === "modrinth") {
        const parsed = parseModrinthWebRef(opts.packId ?? opts.packRef, versionRef);
        if (parsed.mrpackUrl) {
            const { index } = await downloadModrinthPackIndexFromUrl(parsed.mrpackUrl);
            const row = {
                id: parsed.versionRef ?? index.versionId,
                internalVersionId: modrinthInternalVersionId(String(parsed.versionRef ?? index.versionId)),
                name: index.versionId,
                version: index.versionId,
                type: "release",
                mcVersions: index.dependencies.minecraft ? [index.dependencies.minecraft] : [],
                loaders: [pickModrinthLoader(index.dependencies) ?? "unknown"].filter((v) => v !== "unknown"),
                updated: null,
                matchesRef: versionRef === undefined || versionMatchesRef({ id: parsed.versionRef ?? index.versionId, name: index.versionId, version_number: index.versionId }, versionRef),
            };
            return {
                namespace,
                packId: modrinthInternalPackId(String(parsed.packRef ?? parsed.mrpackUrl)),
                sourcePackId: parsed.packRef ?? parsed.mrpackUrl,
                packName: index.name,
                total: 1,
                matches: versionRef === undefined ? undefined : (row.matchesRef ? [row] : []),
                versions: [row],
            };
        }
        if (parsed.versionIdOnly) {
            const version = await getModrinthVersion(parsed.versionIdOnly);
            if (!version) throw new Error(`Modrinth version ${parsed.versionIdOnly} not found`);
            parsed.packRef = version.project_id;
            parsed.versionRef = parsed.versionRef ?? version.id;
        }

        const project = await resolveModrinthPack(parsed.packRef);
        const versions = await getModrinthProjectVersions(project.slug || project.id);
        const rows = versions.map((v) => ({
            id: v.id,
            internalVersionId: modrinthInternalVersionId(v.id),
            name: v.name,
            version: v.version_number,
            type: v.version_type,
            mcVersions: v.game_versions ?? [],
            loaders: v.loaders ?? [],
            updated: v.date_published,
            matchesRef: versionMatchesRef(v, versionRef),
        }));
        return {
            namespace,
            packId: modrinthInternalPackId(project.id),
            sourcePackId: project.id,
            slug: project.slug,
            packName: project.title,
            total: rows.length,
            matches: versionRef === undefined ? undefined : rows.filter((v) => v.matchesRef),
            versions: rows,
        };
    }
    if (namespace === "feedthebeast") {
        const pack = await resolveOfficialFtbPack(opts.packId ?? opts.packRef);
        const rows = (pack.versions ?? []).map((v) => ({
            id: v.id,
            name: v.name,
            type: v.type,
            mcVersions: (v.targets ?? []).filter((t) => t.type === "game" || t.name === "minecraft").map((t) => t.version),
            loaders: (v.targets ?? []).filter((t) => t.type === "modloader").map((t) => t.name),
            updated: v.updated ? new Date(v.updated * 1000).toISOString() : null,
            matchesRef: versionMatchesRef(v, versionRef),
        }));
        return {
            namespace,
            packId: pack.id,
            slug: pack.slug,
            packName: pack.name,
            total: rows.length,
            matches: versionRef === undefined ? undefined : rows.filter((v) => v.matchesRef),
            versions: rows,
        };
    }

    const ns = namespace === "curseforge" ? "curseforge" : "ftb";
    const pack = await resolveModpacksChPack(ns, opts.packId ?? opts.packRef);
    const rows = (pack.versions ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        mcVersions: (v.targets ?? []).filter((t) => t.type === "game" || t.name === "minecraft").map((t) => t.version),
        loaders: (v.targets ?? []).filter((t) => t.type === "modloader").map((t) => t.name),
        updated: new Date(v.updated * 1000).toISOString(),
        matchesRef: versionMatchesRef(v, versionRef),
    }));
    return {
        namespace: ns,
        packId: pack.id,
        packName: pack.name,
        total: rows.length,
        matches: versionRef === undefined ? undefined : rows.filter((v) => v.matchesRef),
        versions: rows,
    };
}

async function resolveModrinthPack(packRef: string | number | undefined): Promise<ModrinthProject> {
    if (packRef === undefined) throw new Error("Provide packId, packRef, or a pack name");
    const parsed = parseModrinthWebRef(packRef);
    if (parsed.versionIdOnly) {
        const version = await getModrinthVersion(parsed.versionIdOnly);
        if (!version) throw new Error(`Modrinth version ${parsed.versionIdOnly} not found`);
        return resolveModrinthPack(version.project_id);
    }
    if (parsed.packRef !== packRef) return resolveModrinthPack(parsed.packRef);
    const direct = await getModrinthProject(String(packRef)).catch(() => null);
    if (direct?.project_type === "modpack" || (direct && direct.project_type === undefined)) return direct;

    const search = await searchModrinthProjects(String(packRef), { projectType: "modpack", limit: 10 });
    const hits = search?.hits ?? [];
    if (hits.length === 0) throw new Error(`No Modrinth modpack found for "${String(packRef)}"`);
    const exact = hits.find((h: ModrinthSearchHit) =>
        normalized(h.slug) === normalized(String(packRef)) ||
        normalized(h.title) === normalized(String(packRef)) ||
        h.project_id === String(packRef)
    );
    const hit = exact ?? hits[0];
    const project = await getModrinthProject(hit.project_id);
    if (!project) throw new Error(`Modrinth project ${hit.project_id} not found after search`);
    return project;
}

async function resolveModrinthVersion(project: ModrinthProject, versionRef?: string | number): Promise<ModrinthVersion> {
    const parsed = parseModrinthWebRef(project.slug || project.id, versionRef);
    versionRef = parsed.versionRef;
    if (versionRef !== undefined && versionRef !== "") {
        const direct = await getModrinthProjectVersion(project.slug || project.id, String(versionRef)).catch(() => null);
        if (direct) return direct;
    }
    const versions = await getModrinthProjectVersions(project.slug || project.id);
    return resolveVersionByRef(versions, versionRef);
}

export async function resolvePackAction(opts: IngestPackOptions): Promise<ResolvedPackVersion> {
    const namespace = opts.namespace ?? "ftb";
    if (namespace === "feedthebeast") return resolveOfficialFtbPackVersion(opts);
    if (namespace !== "modrinth") return resolveModpacksChPackVersion(opts);

    const parsed = parseModrinthWebRef(opts.packId ?? opts.packRef, opts.versionId ?? opts.versionRef);
    if (parsed.mrpackUrl) {
        const { index } = await downloadModrinthPackIndexFromUrl(parsed.mrpackUrl);
        const sourcePackId = String(parsed.packRef ?? parsed.mrpackUrl);
        const sourceVersionId = String(parsed.versionRef ?? index.versionId);
        return {
            namespace: "modrinth",
            packId: modrinthInternalPackId(sourcePackId),
            versionId: modrinthInternalVersionId(sourceVersionId),
            packName: index.name,
            versionName: index.versionId,
            mcVersion: index.dependencies.minecraft ?? null,
            loader: pickModrinthLoader(index.dependencies),
            sourcePackId,
            sourceVersionId,
        };
    }
    if (parsed.versionIdOnly) {
        const version = await getModrinthVersion(parsed.versionIdOnly);
        if (!version) throw new Error(`Modrinth version ${parsed.versionIdOnly} not found`);
        const project = await resolveModrinthPack(version.project_id);
        return {
            namespace: "modrinth",
            packId: modrinthInternalPackId(project.id),
            versionId: modrinthInternalVersionId(version.id),
            packName: project.title,
            versionName: version.name || version.version_number,
            mcVersion: version.game_versions?.[0] ?? null,
            loader: version.loaders?.find((l) => l !== "minecraft") ?? null,
            sourcePackId: project.id,
            sourceVersionId: version.id,
        };
    }

    const project = await resolveModrinthPack(parsed.packRef);
    const version = await resolveModrinthVersion(project, parsed.versionRef);
    return {
        namespace: "modrinth",
        packId: modrinthInternalPackId(project.id),
        versionId: modrinthInternalVersionId(version.id),
        packName: project.title,
        versionName: version.name || version.version_number,
        mcVersion: version.game_versions?.[0] ?? null,
        loader: version.loaders?.find((l) => l !== "minecraft") ?? null,
        sourcePackId: project.id,
        sourceVersionId: version.id,
    };
}

export async function packInfoAction(packId: number, namespace: PackNamespace = "ftb") {
    if (namespace === "modrinth") {
        const project = await getModrinthProject(String(packId));
        if (!project) throw new Error(`Modrinth pack ${packId} not found`);
        const versions = await getModrinthProjectVersions(project.slug || project.id);
        return {
            id: project.id,
            internalPackId: modrinthInternalPackId(project.id),
            slug: project.slug,
            name: project.title,
            synopsis: project.description,
            provider: "modrinth",
            versions: versions.map((v) => ({
                id: v.id,
                internalVersionId: modrinthInternalVersionId(v.id),
                name: v.name,
                version: v.version_number,
                type: v.version_type,
                targets: [
                    ...(v.game_versions ?? []).map((version) => ({ name: "minecraft", version })),
                    ...(v.loaders ?? []).map((name) => ({ name, version: "" })),
                ],
                updated: v.date_published,
            })),
        };
    }
    if (namespace === "feedthebeast") {
        const pack = await getOfficialFtbPack(packId);
        if (!pack) throw new Error(`Official Feed The Beast pack ${packId} not found`);
        return {
            id: pack.id,
            slug: pack.slug,
            name: pack.name,
            synopsis: pack.synopsis,
            provider: "feedthebeast",
            installs: pack.installs,
            plays: pack.plays,
            tags: (pack.tags ?? []).map((t) => t.name),
            authors: (pack.authors ?? []).map((a) => ({ name: a.name, type: a.type })),
            links: (pack.links ?? []).map((l) => ({ type: l.type, url: l.link })),
            versions: (pack.versions ?? []).map((v) => ({
                id: v.id,
                name: v.name,
                type: v.type,
                targets: (v.targets ?? []).map((t) => ({ name: t.name, version: t.version })),
                updated: v.updated ? new Date(v.updated * 1000).toISOString() : null,
            })),
        };
    }

    const pack = namespace === "curseforge"
        ? await getCfPack(packId)
        : await getPack(packId);
    if (!pack) throw new Error(`Pack ${packId} not found on namespace "${namespace}"`);

    // Summarise versions (strip massive description field)
    return {
        id:       pack.id,
        name:     pack.name,
        synopsis: pack.synopsis,
        provider: pack.provider,
        installs: pack.installs,
        tags:     (pack.tags ?? []).map((t) => t.name),
        authors:  (pack.authors ?? []).map((a) => ({ name: a.name, type: a.type })),
        links:    (pack.links ?? []).map((l) => ({ type: l.type, url: l.link })),
        versions: (pack.versions ?? []).map((v) => ({
            id:      v.id,
            name:    v.name,
            type:    v.type,
            targets: (v.targets ?? []).map((t) => ({ name: t.name, version: t.version })),
            updated: new Date(v.updated * 1000).toISOString(),
        })),
    };
}

export async function packManifestAction(packId: number, versionId: number, namespace: PackNamespace = "ftb") {
    if (namespace === "modrinth") {
        throw new Error("Use action=ingest_pack or action=resolve_pack for Modrinth packs; Modrinth manifests are stored inside the .mrpack download.");
    }

    const manifest = namespace === "feedthebeast"
        ? await getOfficialFtbPackManifest(packId, versionId).then((m) => m ? normalizeOfficialFtbManifest(m) : null)
        : namespace === "curseforge"
            ? await getCfPackManifest(packId, versionId)
            : await getPackManifest(packId, versionId);
    if (!manifest) throw new Error(`Manifest not found for pack ${packId} version ${versionId} (${namespace})`);

    const fileSummary = (f: FtbManifestFile) => ({
        id:         f.id,
        name:       f.name,
        type:       f.type,
        path:       f.path,
        size:       f.size,
        sha1:       f.sha1 || null,
        clientonly: f.clientonly,
        serveronly: f.serveronly,
        optional:   f.optional,
        hasCdnUrl:  !!resolveFileUrl(f),
        cfProject:  f.curseforge?.project ?? null,
        cfFile:     f.curseforge?.file    ?? null,
    });

    const manifestFiles = manifest.files ?? [];
    return {
        id:        manifest.id,
        parent:    manifest.parent,
        name:      manifest.name,
        version:   manifest.version,
        type:      manifest.type,
        targets:   (manifest.targets ?? []).map((t) => ({ name: t.name, version: t.version })),
        fileCount: manifestFiles.length,
        byType:    Object.fromEntries(
            [...new Set(manifestFiles.map((f) => f.type))].map((t) => [
                t,
                manifestFiles.filter((f) => f.type === t).length,
            ]),
        ),
        files: manifestFiles.map(fileSummary),
    };
}

// ── FTB mod search ────────────────────────────────────────────────────────────

export async function searchFtbModsAction(term: string, limit = 20) {
    const r = await searchMods(term, limit);
    if (!r) return { mods: [], total: 0, enriched: [] };
    // Enrich the first up to 20 IDs into full mod objects so callers get
    // names/synopses without having to call ftb_mod_info for each hit.
    const mods = r.mods ?? [];
    const take = mods.slice(0, Math.min(mods.length, 20));
    const enriched = await getModsBatch(take);
    return {
        total: r.total ?? 0,
        mods,
        enriched: enriched.map((m) => ({
            id:       m.id,
            name:     m.name,
            synopsis: m.synopsis,
            installs: m.installs,
            links:    (m.links ?? []).map((l) => ({ type: l.type, url: l.link })),
        })),
    };
}

export async function ftbModInfoAction(modId: number | string, opts: {
    mcVersion?: string; loader?: string;
} = {}) {
    const m = await getMod(modId);
    if (!m) throw new Error(`FTB mod ${modId} not found`);

    // Filter versions by mcVersion / loader if requested
    let versions = m.versions as FtbModVersion[];
    if (opts.mcVersion) {
        versions = versions.filter((v) =>
            v.targets.some((t) => t.type === "game" && t.version === opts.mcVersion)
        );
    }
    if (opts.loader) {
        const loaderLower = opts.loader.toLowerCase();
        versions = versions.filter((v) =>
            v.targets.some((t) => t.type === "modloader" && t.name.toLowerCase() === loaderLower)
        );
    }

    return {
        id:       m.id,
        name:     m.name,
        synopsis: m.synopsis,
        installs: m.installs,
        links:    m.links.map((l) => ({ type: l.type, url: l.link })),
        versions: versions.map((v) => ({
            fileId:  v.id,
            name:    v.name,
            version: v.version,
            type:    v.type,
            size:    v.size,
            sha1:    v.sha1 || null,
            url:     resolveModVersionUrl(v),
            mcVersions: v.targets.filter((t) => t.type === "game").map((t) => t.version),
            loaders:    v.targets.filter((t) => t.type === "modloader").map((t) => t.name),
            updated: new Date(v.updated * 1000).toISOString(),
        })),
    };
}

/**
 * Download and ingest a single mod JAR from the modpacks.ch CDN.
 * No CF API key required.
 *
 * @param modId    - CF project ID (integer) or Modrinth slug/ID (string)
 * @param opts.mcVersion - Filter to versions for this MC version
 * @param opts.loader    - Filter to versions for this loader (neoforge, fabric, etc.)
 * @param opts.fileId    - Exact CF file ID to download (skip filtering)
 * @param opts.force     - Re-download even if the file is already in cache
 */
export async function downloadModAction(modId: number | string, opts: {
    mcVersion?: string; loader?: string; fileId?: number; force?: boolean;
} = {}): Promise<{
    status: string;
    modId?: number;
    name?: string;
    version?: string;
    jarPath?: string;
    message?: string;
}> {
    const m = await getMod(modId);
    if (!m) throw new Error(`Mod ${modId} not found on modpacks.ch`);

    let candidates = m.versions as FtbModVersion[];

    if (opts.fileId !== undefined) {
        // Exact file requested
        candidates = candidates.filter((v) => v.id === opts.fileId);
    } else {
        if (opts.mcVersion) {
            candidates = candidates.filter((v) =>
                v.targets.some((t) => t.type === "game" && t.version === opts.mcVersion)
            );
        }
        if (opts.loader) {
            const lo = opts.loader.toLowerCase();
            candidates = candidates.filter((v) =>
                v.targets.some((t) => t.type === "modloader" && t.name.toLowerCase() === lo)
            );
        }
    }

    if (candidates.length === 0) {
        throw new Error(
            `No version of mod ${m.name} (${modId}) matches the requested filters` +
            (opts.mcVersion ? ` mcVersion=${opts.mcVersion}` : "") +
            (opts.loader    ? ` loader=${opts.loader}`       : "")
        );
    }

    // Take the first (most recent) matching version
    const version = candidates[0];
    const url = resolveModVersionUrl(version);
    if (!url) throw new Error(`No download URL available for ${version.name}`);

    // Build a stable cache path: use sha1 when available
    const key      = version.sha1 || String(version.id);
    const destPath = join(CACHE_ROOT, "mods", String(m.id), `${key}.jar`);
    const tmpPath  = destPath + ".tmp";

    await ensureDir(destPath);

    if (opts.force || !(await exists(destPath))) {
        const res = await fetchWithRetry(url, { headers: MOD_HEADERS }, DOWNLOAD_OPTS);
        if (!res.ok) throw new Error(`Download failed for ${version.name}: HTTP ${res.status}`);
        const stream = createWriteStream(tmpPath);
        await pipeline(res.body as unknown as NodeJS.ReadableStream, stream);
        await rename(tmpPath, destPath);
    }

    const result = await ingestMod(destPath, /* skipSource */ true);
    return {
        status:  result.status,
        modId:   result.status === "ingested" || result.status === "replaced" || result.status === "already_ingested"
                     ? (result.mod?.id ?? (result as { existingDbId?: number }).existingDbId)
                     : undefined,
        name:    version.name,
        version: version.version,
        jarPath: destPath,
        message: "message" in result ? result.message : undefined,
    };
}

// ── Sync pack mods ────────────────────────────────────────────────────────────

/**
 * Download and ingest every mod (and optionally resource/datapack) from a
 * modpack manifest into the ModLens database.
 *
 * Works for both FTB packs and CurseForge packs via the modpacks.ch API —
 * no CurseForge API key required.
 */
export async function syncPackModsAction(opts: SyncPackModsOptions): Promise<{
    packId:          number;
    versionId:       number;
    namespace:       string;
    packVersionDbId: number;
    total:           number;
    ingested:        number;
    skipped:         number;
    failed:          number;
    files:           FileResult[];
}> {
    const { packId, versionId, namespace, concurrency = 3 } = opts;
    const ingestTypes  = opts.fileTypes   ?? ["mod", "resource"];
    const skipServer   = opts.skipServer  ?? false;
    const skipOptional = opts.skipOptional ?? false;

    const manifest: FtbManifest | null = namespace === "feedthebeast"
        ? await getOfficialFtbPackManifest(packId, versionId).then((m) => m ? normalizeOfficialFtbManifest(m) : null)
        : namespace === "curseforge"
            ? await getCfPackManifest(packId, versionId)
            : await getPackManifest(packId, versionId);

    if (!manifest) {
        throw new Error(`Manifest not found for pack ${packId} v${versionId} (${namespace})`);
    }

    // Filter to downloadable, ingestable file types
    const candidates = manifest.files.filter((f) => {
        if (!ingestTypes.includes(f.type)) return false;
        if (skipServer   && f.serveronly)  return false;
        if (skipOptional && f.optional)    return false;
        if (!resolveFileUrl(f))            return false;  // no URL → skip
        return true;
    }).slice(0, opts.maxFiles ?? undefined);

    const packCacheDir = join(CACHE_ROOT, "packs", String(namespace), String(packId), String(versionId));
    const results: FileResult[] = [];

    // Process `concurrency` files at a time
    for (let i = 0; i < candidates.length; i += concurrency) {
        const batch = candidates.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map((file) => processFile(file, packCacheDir)));
        results.push(...batchResults);
    }

    // ── Record pack membership ────────────────────────────────────────────────
    // Upsert the pack version row first.
    const mcVersion  = manifest.targets.find((t) => t.name === "minecraft")?.version ?? null;
    const modloader  = manifest.targets.find((t) => t.type === "modloader")?.name    ?? null;
    const pvId = await upsertPackVersion({
        namespace,
        packId,
        versionId,
        packName:    opts.packName ?? manifest.name,
        versionName: (opts.versionName ?? manifest.version) || manifest.name,
        mcVersion,
        modloader,
    });

    // Build a map from manifest file id → processed result.
    const resultMap = new Map<number, FileResult>();
    for (const r of results) {
        if (r.fileId !== undefined) resultMap.set(r.fileId, r);
    }

    // Upsert one PackFile row per manifest entry (ALL files, not just candidates).
    await Promise.all(manifest.files.map((f) => {
        const processed = resultMap.get(f.id);
        return upsertPackFile({
            packVersionId:   pvId,
            manifestFileId:  f.id,
            fileType:        f.type,
            fileName:        f.name,
            filePath:        f.path  || null,
            cfProject:       f.curseforge?.project ?? null,
            cfFile:          f.curseforge?.file    ?? null,
            sha1:            f.sha1 || null,
            status:          processed?.status ?? "not_synced",
            modId:           processed?.dbId   ?? null,
        });
    }));

    const ingested = results.filter((r) => r.status === "ingested" || r.status === "replaced").length;
    const skipped  = results.filter((r) => r.status === "already_ingested" || r.status === "duplicate_version" || r.status === "duplicate_hash").length;
    const failed   = results.filter((r) => r.status === "error").length;

    return {
        packId,
        versionId,
        namespace,
        packVersionDbId: pvId,
        total:    candidates.length,
        ingested,
        skipped,
        failed,
        files:    results,
    };
}

async function processFile(file: FtbManifestFile, cacheDir: string): Promise<FileResult> {
    const url = resolveFileUrl(file)!;
    // Derive a stable local path: sha1 preferred, fall back to name hash
    const key     = file.sha1 || createHash("sha1").update(url).digest("hex");
    const ext     = file.name.endsWith(".zip") ? ".zip" : ".jar";
    const destPath = join(cacheDir, `${key}${ext}`);

    try {
        await ensureDir(destPath);

        if (!(await exists(destPath))) {
            // Download to a temp path then rename atomically
            const tmpPath = destPath + ".tmp";
            await downloadManifestFile(file, tmpPath);
            await rename(tmpPath, destPath);
        }

        // Only ingest JARs (mods) — ZIPs are resource/datapacks that the
        // ingestMod path doesn't handle yet.
        if (ext === ".zip") {
            return { name: file.name, type: file.type, fileId: file.id, status: "downloaded_zip" };
        }

        const result = await ingestMod(destPath, /* skipSource */ true);
        return {
            name:    file.name,
            type:    file.type,
            fileId:  file.id,
            status:  result.status,
            dbId:    result.status === "ingested" || result.status === "replaced"
                        ? result.mod?.id
                        : result.status === "already_ingested"
                            ? result.mod?.id
                            : (result as { existingDbId?: number }).existingDbId,
            message: "message" in result ? result.message : undefined,
        };
    } catch (err) {
        return {
            name:    file.name,
            type:    file.type,
            fileId:  file.id,
            status:  "error",
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

// ── Pack membership queries ───────────────────────────────────────────────────

/** List all pack versions recorded in the DB, optionally filtered by namespace / packId. */
async function downloadUrlToFile(url: string, destPath: string): Promise<void> {
    const res = await fetchWithRetry(url, { headers: MOD_HEADERS }, DOWNLOAD_OPTS);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
    const writer = createWriteStream(destPath);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
}

async function processDownloadableFile(file: DownloadablePackFile, cacheDir: string): Promise<FileResult> {
    const key = file.sha1 || createHash("sha1").update(file.url).digest("hex");
    const ext = extname(file.name).toLowerCase() || (file.type === "mod" ? ".jar" : "");
    const destPath = join(cacheDir, `${key}${ext}`);

    try {
        await ensureDir(destPath);
        if (!(await exists(destPath))) {
            const tmpPath = destPath + ".tmp";
            try {
                await downloadUrlToFile(file.url, tmpPath);
                await rename(tmpPath, destPath);
            } catch (err) {
                await unlink(tmpPath).catch(() => {});
                throw err;
            }
        }

        if (ext !== ".jar") {
            return { name: file.name, type: file.type, fileId: file.id, status: ext === ".zip" ? "downloaded_zip" : "downloaded" };
        }

        const result = await ingestMod(destPath, /* skipSource */ true);
        return {
            name:    file.name,
            type:    file.type,
            fileId:  file.id,
            status:  result.status,
            dbId:    result.status === "ingested" || result.status === "replaced"
                        ? result.mod?.id
                        : result.status === "already_ingested" || result.status === "metadata_refreshed"
                            ? result.mod?.id
                            : (result as { existingDbId?: number }).existingDbId,
            message: "message" in result ? result.message : undefined,
        };
    } catch (err) {
        return {
            name:    file.name,
            type:    file.type,
            fileId:  file.id,
            status:  "error",
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

async function downloadModrinthPackIndex(project: ModrinthProject, version: ModrinthVersion): Promise<{
    index: ModrinthPackIndex;
    mrpackPath: string;
}> {
    const file = getModrinthPrimaryFile(version);
    if (!file) throw new Error(`Modrinth version ${version.id} has no downloadable files`);
    if (!file.filename.endsWith(".mrpack")) {
        throw new Error(`Primary file for Modrinth version ${version.id} is not an .mrpack: ${file.filename}`);
    }

    const packDir = join(CACHE_ROOT, "packs", "modrinth", project.id, version.id);
    const mrpackPath = join(packDir, file.filename);
    await mkdir(packDir, { recursive: true });

    if (!(await exists(mrpackPath))) {
        const tmpPath = mrpackPath + ".tmp";
        try {
            await downloadUrlToFile(file.url, tmpPath);
            await rename(tmpPath, mrpackPath);
        } catch (err) {
            await unlink(tmpPath).catch(() => {});
            throw err;
        }
    }

    const index = readModrinthPackIndex(mrpackPath, file.filename);
    return { index, mrpackPath };
}

function readModrinthPackIndex(mrpackPath: string, label: string): ModrinthPackIndex {
    const zip = new AdmZip(mrpackPath);
    const indexEntry = zip.getEntry("modrinth.index.json");
    if (!indexEntry) throw new Error(`Modrinth pack ${label} has no modrinth.index.json`);
    return JSON.parse(indexEntry.getData().toString("utf8")) as ModrinthPackIndex;
}

async function downloadModrinthPackIndexFromUrl(mrpackUrl: string): Promise<{
    index: ModrinthPackIndex;
    mrpackPath: string;
}> {
    const url = new URL(mrpackUrl);
    if (url.protocol !== "https:") throw new Error(`Modrinth .mrpack URL must use HTTPS: ${mrpackUrl}`);
    if (!url.pathname.toLowerCase().endsWith(".mrpack")) throw new Error(`Expected a .mrpack URL, got: ${mrpackUrl}`);

    const urlKey = createHash("sha1").update(url.toString()).digest("hex");
    const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "pack.mrpack");
    const packDir = join(CACHE_ROOT, "packs", "modrinth-url", urlKey);
    const mrpackPath = join(packDir, filename);
    await mkdir(packDir, { recursive: true });

    if (!(await exists(mrpackPath))) {
        const tmpPath = mrpackPath + ".tmp";
        try {
            await downloadUrlToFile(url.toString(), tmpPath);
            await rename(tmpPath, mrpackPath);
        } catch (err) {
            await unlink(tmpPath).catch(() => {});
            throw err;
        }
    }

    return { index: readModrinthPackIndex(mrpackPath, filename), mrpackPath };
}

interface SyncModrinthIndexMeta {
    packId: number;
    versionId: number;
    sourcePackId: string;
    sourceVersionId: string;
    packName: string;
    versionName: string;
    mcVersion?: string | null;
    loaders?: string[];
}

async function syncModrinthIndex(opts: IngestPackOptions, meta: SyncModrinthIndexMeta, index: ModrinthPackIndex, mrpackPath: string): Promise<{
    packId: number;
    versionId: number;
    namespace: string;
    packVersionDbId: number;
    sourcePackId: string;
    sourceVersionId: string;
    mrpackPath: string;
    total: number;
    ingested: number;
    skipped: number;
    failed: number;
    files: FileResult[];
}> {
    const ingestTypes = opts.fileTypes ?? ["mod", "resource"];
    const skipServer = opts.skipServer ?? false;
    const skipOptional = opts.skipOptional ?? false;
    const concurrency = opts.concurrency ?? 3;

    const downloadable = index.files.map((f): DownloadablePackFile | null => {
        const type = classifyModrinthPath(f.path);
        const url = f.downloads?.[0];
        if (!url) return null;
        return {
            id: hashToInt(`modrinth:file:${meta.sourceVersionId}:${f.path}`),
            name: basename(f.path),
            type,
            path: f.path,
            url,
            sha1: f.hashes?.sha1 ?? null,
            serveronly: f.env?.client === "unsupported" && f.env.server !== "unsupported",
            optional: f.env?.client === "optional" || f.env?.server === "optional",
        };
    }).filter((f): f is DownloadablePackFile => f !== null);

    const candidates = downloadable.filter((f) => {
        if (!ingestTypes.includes(f.type)) return false;
        if (skipServer && f.serveronly) return false;
        if (skipOptional && f.optional) return false;
        return true;
    }).slice(0, opts.maxFiles ?? undefined);

    const packCacheDir = join(CACHE_ROOT, "packs", "modrinth", meta.sourcePackId.replace(/[^a-zA-Z0-9._-]/g, "_"), meta.sourceVersionId.replace(/[^a-zA-Z0-9._-]/g, "_"), "files");
    const results: FileResult[] = [];
    for (let i = 0; i < candidates.length; i += concurrency) {
        const batch = candidates.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map((file) => processDownloadableFile(file, packCacheDir)));
        results.push(...batchResults);
    }

    const modloader = pickModrinthLoader(index.dependencies, meta.loaders);
    const pvId = await upsertPackVersion({
        namespace:   "modrinth",
        packId:      meta.packId,
        versionId:   meta.versionId,
        packName:    meta.packName,
        versionName: meta.versionName,
        mcVersion:   index.dependencies.minecraft ?? meta.mcVersion ?? null,
        modloader,
    });

    const resultMap = new Map<number, FileResult>();
    for (const r of results) {
        if (r.fileId !== undefined) resultMap.set(r.fileId, r);
    }

    await Promise.all(downloadable.map((f) => {
        const processed = resultMap.get(f.id);
        return upsertPackFile({
            packVersionId:  pvId,
            manifestFileId: f.id,
            fileType:       f.type,
            fileName:       f.name,
            filePath:       f.path || null,
            sha1:           f.sha1 || null,
            status:         processed?.status ?? "not_synced",
            modId:          processed?.dbId ?? null,
        });
    }));

    const ingested = results.filter((r) => r.status === "ingested" || r.status === "replaced" || r.status === "metadata_refreshed").length;
    const skipped = results.filter((r) => r.status === "already_ingested" || r.status === "duplicate_version" || r.status === "duplicate_hash").length;
    const failed = results.filter((r) => r.status === "error").length;

    return {
        packId: meta.packId,
        versionId: meta.versionId,
        namespace: "modrinth",
        packVersionDbId: pvId,
        sourcePackId: meta.sourcePackId,
        sourceVersionId: meta.sourceVersionId,
        mrpackPath,
        total: candidates.length,
        ingested,
        skipped,
        failed,
        files: results,
    };
}

export async function syncModrinthPackAction(opts: IngestPackOptions) {
    const parsed = parseModrinthWebRef(opts.packId ?? opts.packRef, opts.versionId ?? opts.versionRef);
    if (parsed.mrpackUrl) {
        const { index, mrpackPath } = await downloadModrinthPackIndexFromUrl(parsed.mrpackUrl);
        const sourcePackId = String(parsed.packRef ?? parsed.mrpackUrl);
        const sourceVersionId = String(parsed.versionRef ?? index.versionId);
        return syncModrinthIndex(opts, {
            packId: modrinthInternalPackId(sourcePackId),
            versionId: modrinthInternalVersionId(sourceVersionId),
            sourcePackId,
            sourceVersionId,
            packName: index.name,
            versionName: index.versionId,
            mcVersion: index.dependencies.minecraft ?? null,
        }, index, mrpackPath);
    }
    if (parsed.versionIdOnly) {
        const version = await getModrinthVersion(parsed.versionIdOnly);
        if (!version) throw new Error(`Modrinth version ${parsed.versionIdOnly} not found`);
        const project = await resolveModrinthPack(version.project_id);
        const { index, mrpackPath } = await downloadModrinthPackIndex(project, version);
        return syncModrinthIndex(opts, {
            packId: modrinthInternalPackId(project.id),
            versionId: modrinthInternalVersionId(version.id),
            sourcePackId: project.id,
            sourceVersionId: version.id,
            packName: project.title,
            versionName: version.name || version.version_number || index.versionId,
            mcVersion: version.game_versions?.[0] ?? null,
            loaders: version.loaders,
        }, index, mrpackPath);
    }

    const project = await resolveModrinthPack(parsed.packRef);
    const version = await resolveModrinthVersion(project, parsed.versionRef);
    const { index, mrpackPath } = await downloadModrinthPackIndex(project, version);
    return syncModrinthIndex(opts, {
        packId: modrinthInternalPackId(project.id),
        versionId: modrinthInternalVersionId(version.id),
        sourcePackId: project.id,
        sourceVersionId: version.id,
        packName: project.title,
        versionName: version.name || version.version_number || index.versionId,
        mcVersion: version.game_versions?.[0] ?? null,
        loaders: version.loaders,
    }, index, mrpackPath);
}

export async function ingestPackAction(opts: IngestPackOptions) {
    const namespace = opts.namespace ?? "ftb";
    if (namespace === "modrinth") return syncModrinthPackAction(opts);

    const resolved = namespace === "feedthebeast"
        ? await resolveOfficialFtbPackVersion(opts)
        : await resolveModpacksChPackVersion(opts);
    const result = await syncPackModsAction({
        packId: resolved.packId,
        versionId: resolved.versionId,
        namespace: resolved.namespace as Exclude<PackNamespace, "modrinth">,
        packName: resolved.packName,
        versionName: resolved.versionName,
        fileTypes: opts.fileTypes,
        skipServer: opts.skipServer,
        skipOptional: opts.skipOptional,
        concurrency: opts.concurrency,
        maxFiles: opts.maxFiles,
    });
    return {
        ...result,
        resolved,
    };
}

export async function listPackVersionsAction(namespace?: string, packId?: number) {
    const rows = await listPackVersions(namespace, packId);
    return {
        total: rows.length,
        versions: rows.map((v) => ({
            dbId:        v.id,
            namespace:   v.namespace,
            packId:      v.packId,
            versionId:   v.versionId,
            packName:    v.packName,
            versionName: v.versionName,
            mcVersion:   v.mcVersion,
            modloader:   v.modloader,
            syncedAt:    v.syncedAt,
        })),
    };
}

/**
 * List all files recorded for a specific pack version.
 * Look up the version by either its DB id (packVersionDbId) or
 * the (namespace + packId + versionId) triple.
 */
export async function listPackFilesAction(opts: {
    packVersionDbId?: number;
    namespace?: string;
    packId?: number;
    versionId?: number;
    fileType?: string;
}) {
    let pvId = opts.packVersionDbId;
    if (pvId === undefined) {
        if (!opts.namespace || opts.packId === undefined || opts.versionId === undefined) {
            throw new Error("Provide either packVersionDbId or (namespace + packId + versionId)");
        }
        const pv = await findPackVersion(opts.namespace, opts.packId, opts.versionId);
        if (!pv) throw new Error(`Pack version not yet recorded — run sync_pack_mods first`);
        pvId = pv.id;
    }
    const files = await listPackFiles(pvId);
    const filtered = opts.fileType ? files.filter((f) => f.fileType === opts.fileType) : files;
    return {
        packVersionDbId: pvId,
        total:   filtered.length,
        byType:  Object.fromEntries(
            [...new Set(files.map((f) => f.fileType))].map((t) => [
                t,
                files.filter((f) => f.fileType === t).length,
            ]),
        ),
        files: filtered.map((f) => ({
            id:             f.id,
            manifestFileId: f.manifestFileId,
            fileType:       f.fileType,
            fileName:       f.fileName,
            filePath:       f.filePath,
            cfProject:      f.cfProject,
            cfFile:         f.cfFile,
            sha1:           f.sha1,
            status:         f.status,
            modId:          f.modId,
        })),
    };
}

/**
 * Find every pack version that contains a given mod.
 * Accepts a ModLens DB mod id (modDbId) or a CurseForge project id (cfProject).
 */
export async function findModInPacksAction(opts: { modDbId?: number; cfProject?: number }) {
    if (opts.modDbId !== undefined) {
        const rows = await findPacksForMod(opts.modDbId);
        return { modDbId: opts.modDbId, packs: rows };
    }
    if (opts.cfProject !== undefined) {
        const rows = await findPacksForCfProject(opts.cfProject);
        return { cfProject: opts.cfProject, packs: rows };
    }
    throw new Error("Provide either modDbId or cfProject");
}

/**
 * Download and extract the overrides ZIP (KubeJS scripts, configs, defaultconfigs,
 * resource overrides, etc.) for a CurseForge pack version.
 *
 * The overrides are extracted to:
 *   CACHE_ROOT/packs/curseforge/{packId}/{versionId}/overrides/
 *
 * The corresponding PackFile record is updated to status "extracted".
 */
export async function downloadOverridesAction(opts: {
    namespace:  string;
    packId:     number;
    versionId:  number;
    force?:     boolean;
}) {
    const { namespace, packId, versionId, force = false } = opts;

    const manifest = namespace === "curseforge"
        ? await getCfPackManifest(packId, versionId)
        : await getPackManifest(packId, versionId);

    if (!manifest) throw new Error(`Manifest not found for pack ${packId} v${versionId} (${namespace})`);

    const overrideFile = manifest.files.find((f) => f.type === "cf-extract");
    if (!overrideFile) throw new Error("No cf-extract (overrides) entry found in manifest");

    // Use the URL from the manifest (the full CF pack ZIP like "All the Mods 10-7.0.zip")
    const url = resolveFileUrl(overrideFile);
    if (!url) throw new Error(`No download URL for cf-extract entry in pack ${packId} v${versionId}`);

    const packCacheDir  = join(CACHE_ROOT, "packs", namespace, String(packId), String(versionId));
    // Store under the real filename, not "overrides.zip"
    const urlFilename   = decodeURIComponent(url.split("/").pop() ?? "pack.zip");
    const zipPath       = join(packCacheDir, urlFilename);
    const extractDir    = join(packCacheDir, "overrides");

    await mkdir(packCacheDir, { recursive: true });

    // Download if not cached (or forced)
    if (force || !(await exists(zipPath))) {
        const tmpPath = zipPath + ".tmp";
        const res = await fetchWithRetry(url, { headers: MOD_HEADERS }, DOWNLOAD_OPTS);
        if (!res.ok) throw new Error(`Failed to download overrides.zip: HTTP ${res.status} from ${url}`);
        const writer = createWriteStream(tmpPath);
        await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
        await rename(tmpPath, zipPath);
    }

    // Extract with zip-slip protection: validate each entry resolves inside extractDir
    await mkdir(extractDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    const resolvedExtractDir = resolve(extractDir);
    for (const entry of zip.getEntries()) {
        const target = resolve(extractDir, entry.entryName);
        if (!target.startsWith(resolvedExtractDir + sep) && target !== resolvedExtractDir) {
            throw new Error(`Zip-slip detected: entry "${entry.entryName}" escapes extract dir`);
        }
    }
    zip.extractAllTo(extractDir, /* overwrite */ true);

    const entries = zip.getEntries().map((e) => e.entryName);
    const topDirs = [...new Set(entries.map((e) => e.split("/")[0]))].sort();

    // Update pack_file status in DB
    const pv = await findPackVersion(namespace, packId, versionId);
    if (pv) {
        await upsertPackFile({
            packVersionId:  pv.id,
            manifestFileId: overrideFile.id,
            fileType:       overrideFile.type,
            fileName:       overrideFile.name,
            filePath:       overrideFile.path || null,
            status:         "extracted",
        });
    }

    return {
        status:      "extracted",
        zipPath,
        extractDir,
        fileCount:   entries.length,
        topDirs,
        url,
    };
}
