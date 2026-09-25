/** Resolve a ModLens mod reference to one verified JAR. */
import AdmZip from "adm-zip";
import { existsSync } from "node:fs";
import type { Mod } from "@prisma/client";
import { fileSha1 } from "./security.js";
import { inspectJarLoaders, parseJar } from "./processor.js";
import { getMod, getModsBatch, providerVersions, searchMods, type ModVersion } from "./modpacks-ch.js";
import { downloadModVersion } from "./mod-artifacts.js";
import { findModById, findModBySha1, findModsByExactModId, updateMod } from "./repositories/mod.js";
import { ingestMod } from "./tools/ingest.js";

export interface ModReference {
    modId?: string | number;
    dbId?: number;
    sha1?: string;
    mcVersion?: string;
    modVersion?: string;
    loader?: string;
    className?: string;
}

export interface StagedMod {
    jarPath: string;
    mod?: Mod;
    version?: string;
    sourceUrl?: string;
}

/** Safe, actionable identity failures that may be returned to hosted callers. */
export class ModReferenceError extends Error {}

const pending = new Map<string, Promise<StagedMod>>();
const ingestPending = new Map<string, Promise<Mod>>();
const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
const isNumeric = (value: string) => /^\d+$/.test(value);

function classInJar(jarPath: string, className?: string): boolean {
    if (!className) return true;
    const path = `${className.replace(/\.class$/, "").replace(/\./g, "/")}.class`;
    try { return new AdmZip(jarPath).getEntry(path) !== null; }
    catch { return false; }
}

function matchesHints(mod: Mod, ref: ModReference): boolean {
    return (!ref.mcVersion || mod.mcVersion === ref.mcVersion)
        && (!ref.modVersion || mod.version === ref.modVersion)
        && (!ref.loader || mod.loader.toLowerCase() === ref.loader.toLowerCase());
}

async function ensureSha1(mod: Mod): Promise<string> {
    const sha1 = await fileSha1(mod.jarPath);
    if (mod.sha1?.toLowerCase() !== sha1) await updateMod(mod.id, { sha1 });
    return sha1;
}

function ambiguous(label: string, versions: Array<{ id: string | number; name: string; sha1?: string }>): never {
    const candidates = versions.slice(0, 8).map(v => `${v.name} [${v.sha1 || v.id}]`).join(", ");
    throw new ModReferenceError(`Ambiguous mod ${label}; provide the JAR SHA-1. Candidates: ${candidates}`);
}

async function stageRemoteVersion(projectId: string | number, version: ModVersion, ref: ModReference): Promise<StagedMod> {
    if (!/^[a-f0-9]{40}$/i.test(version.sha1 ?? "")) throw new ModReferenceError(`modpacks.ch has no SHA-1 for ${version.name}`);
    if (ref.modVersion && version.version !== ref.modVersion) throw new ModReferenceError("SHA-1 file does not match the requested mod version");
    if (ref.mcVersion && version.targets?.some(target => target.type === "game")
        && !version.targets.some(target => target.type === "game" && target.version === ref.mcVersion)) {
        throw new ModReferenceError("SHA-1 file does not match the requested Minecraft version");
    }
    const jarPath = await downloadModVersion(projectId, version);
    if (await fileSha1(jarPath) !== version.sha1.toLowerCase()) throw new ModReferenceError(`SHA-1 mismatch for ${version.name}`);
    if (ref.sha1 && version.sha1.toLowerCase() !== ref.sha1.toLowerCase()) throw new ModReferenceError("Resolved JAR SHA-1 differs from the requested hash");
    const manifest = await parseJar(jarPath);
    if (ref.loader && !(await inspectJarLoaders(jarPath)).includes(ref.loader.toLowerCase() as "fabric" | "forge" | "neoforge" | "quilt")) {
        throw new ModReferenceError("SHA-1 file does not match the requested loader");
    }
    if (typeof ref.modId === "string" && manifest.modId.toLowerCase() !== ref.modId.toLowerCase()) {
        throw new ModReferenceError(`JAR declares mod ID ${manifest.modId}, not ${ref.modId}`);
    }
    if (!classInJar(jarPath, ref.className)) throw new ModReferenceError(`Class ${ref.className} is absent from the resolved JAR`);
    return { jarPath, version: version.version };
}

async function findRemote(ref: ModReference): Promise<StagedMod> {
    const id = ref.modId;
    if (typeof id !== "string") throw new ModReferenceError(`Mod not found: ${String(id ?? ref.dbId ?? "")}`);
    if (ref.sha1) {
        const project = await getMod(ref.sha1);
        if (!project) throw new ModReferenceError(`JAR SHA-1 ${ref.sha1} was not found on modpacks.ch`);
        const versions = await providerVersions("mod", project.id);
        const match = versions.find(v => v.sha1?.toLowerCase() === ref.sha1!.toLowerCase());
        if (!match) throw new ModReferenceError(`modpacks.ch did not identify a file matching SHA-1 ${ref.sha1}`);
        return stageRemoteVersion(project.id, match, ref);
    }
    const found = await searchMods(id, 20);
    const projects = await getModsBatch(found?.mods ?? []);
    const wanted = normalized(id);
    const exact = projects.filter(project => [project.slug, project.name, String(project.id)]
        .some(value => value && normalized(value) === wanted));
    if (exact.length !== 1) {
        if (!exact.length) throw new ModReferenceError(`Mod ${id} was not found on modpacks.ch; provide a JAR SHA-1`);
        ambiguous(id, exact.map(project => ({ id: project.id, name: project.name })));
    }
    const project = exact[0];
    const versions = (await providerVersions("mod", project.id, { mcVersion: ref.mcVersion, loader: ref.loader }))
        .filter(v => /^[a-f0-9]{40}$/i.test(v.sha1 ?? "") && (!ref.modVersion || v.version === ref.modVersion));
    if (versions.length === 1) return stageRemoteVersion(project.id, versions[0], ref);
    if (ref.className && versions.length > 1 && versions.length <= 8) {
        const matches: StagedMod[] = [];
        for (const version of versions) {
            try { matches.push(await stageRemoteVersion(project.id, version, ref)); }
            catch (error) {
                if (!/absent from the resolved JAR/.test(String(error))) throw error;
            }
        }
        if (matches.length === 1) return matches[0];
    }
    if (!versions.length) throw new ModReferenceError(`No compatible JAR for ${id} was found on modpacks.ch`);
    ambiguous(id, versions);
}

async function stageUnshared(ref: ModReference): Promise<StagedMod> {
    if (ref.sha1 && !/^[a-f0-9]{40}$/i.test(ref.sha1)) throw new ModReferenceError("sha1 must be a 40-character hexadecimal JAR SHA-1");
    const id = ref.dbId ?? ref.modId;
    if (id === undefined || id === "") throw new ModReferenceError("modId or dbId is required");
    const numberId = typeof id === "number" ? id : isNumeric(id) ? Number(id) : undefined;
    if (numberId !== undefined) {
        const mod = await findModById(numberId);
        if (!mod) throw new ModReferenceError(`Mod #${numberId} not found`);
        if (typeof ref.modId === "string" && !isNumeric(ref.modId) && mod.modId.toLowerCase() !== ref.modId.toLowerCase()) {
            throw new ModReferenceError(`Selected JAR declares mod ID ${mod.modId}, not ${ref.modId}`);
        }
        if (!existsSync(mod.jarPath) || !matchesHints(mod, ref) || !classInJar(mod.jarPath, ref.className)) {
            throw new ModReferenceError("Selected JAR is unavailable or does not match the requested version, loader, or class");
        }
        if (ref.sha1 && await ensureSha1(mod) !== ref.sha1.toLowerCase()) throw new ModReferenceError("SHA-1 does not match the selected database mod");
        return { jarPath: mod.jarPath, mod, version: mod.version };
    }
    const name = String(id);
    let local = (await findModsByExactModId(name)).filter(mod => matchesHints(mod, ref) && existsSync(mod.jarPath));
    if (ref.sha1) {
        const indexed = await findModBySha1(ref.sha1.toLowerCase());
        if (indexed && indexed.modId.toLowerCase() !== name.toLowerCase()) throw new ModReferenceError(`SHA-1 belongs to ${indexed.modId}, not ${name}`);
        if (indexed && matchesHints(indexed, ref) && existsSync(indexed.jarPath)
            && await ensureSha1(indexed) === ref.sha1.toLowerCase()) local = [indexed];
        else local = (await Promise.all(local.map(async mod => await ensureSha1(mod) === ref.sha1!.toLowerCase() ? mod : null)))
            .filter((mod): mod is Mod => mod !== null);
    }
    local = local.filter(mod => existsSync(mod.jarPath) && classInJar(mod.jarPath, ref.className));
    if (local.length === 1) return { jarPath: local[0].jarPath, mod: local[0], version: local[0].version };
    if (local.length > 1) ambiguous(name, local.map(mod => ({ id: mod.id, name: `${mod.modId} ${mod.version}`, sha1: mod.sha1 ?? undefined })));
    return findRemote({ ...ref, modId: name });
}

/** Stage only: callers may inspect a hosted license before ingestion. */
export async function stageModReference(ref: ModReference): Promise<StagedMod> {
    const key = JSON.stringify([ref.dbId, ref.modId, ref.sha1?.toLowerCase(), ref.mcVersion, ref.modVersion, ref.loader, ref.className]);
    const existing = pending.get(key);
    if (existing) return existing;
    const task = stageUnshared(ref);
    pending.set(key, task);
    try { return await task; }
    finally { pending.delete(key); }
}

export async function ingestStagedMod(staged: StagedMod): Promise<Mod> {
    if (staged.mod) return staged.mod;
    const existingTask = ingestPending.get(staged.jarPath);
    if (existingTask) return existingTask;
    const task = (async () => {
        const result = await ingestMod(staged.jarPath, true);
        if ("mod" in result && result.mod) return result.mod;
        if ("existingDbId" in result) {
            const existing = await findModById(result.existingDbId);
            if (existing && await fileSha1(existing.jarPath) === await fileSha1(staged.jarPath)) return existing;
        }
        throw new ModReferenceError(`Resolved JAR could not be indexed: ${"message" in result ? result.message : result.status}`);
    })();
    ingestPending.set(staged.jarPath, task);
    try { return await task; }
    finally { ingestPending.delete(staged.jarPath); }
}

export async function resolveModReference(ref: ModReference): Promise<Mod> {
    return ingestStagedMod(await stageModReference(ref));
}
