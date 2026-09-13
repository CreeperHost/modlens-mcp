/**
 * Repository layer for PackVersion and PackFile tables.
 * Tracks which files (mods, configs, scripts, etc.) are present in each
 * modpack version that has been synced or inspected via sync_pack_mods.
 */
import { getDb } from "../db.js";
import type { PackVersion, PackFile } from "@prisma/client";

// ── Upserts ───────────────────────────────────────────────────────────────────

export interface UpsertPackVersionInput {
    namespace:   string;
    packId:      number;
    versionId:   number;
    packName:    string;
    versionName: string;
    mcVersion?:  string | null;
    modloader?:  string | null;
}

/** Upsert a pack version record and return its DB id. */
export async function upsertPackVersion(input: UpsertPackVersionInput): Promise<number> {
    const db = await getDb();
    const record = await db.packVersion.upsert({
        where: {
            namespace_packId_versionId: {
                namespace: input.namespace,
                packId:    input.packId,
                versionId: input.versionId,
            },
        },
        create: {
            namespace:   input.namespace,
            packId:      input.packId,
            versionId:   input.versionId,
            packName:    input.packName,
            versionName: input.versionName,
            mcVersion:   input.mcVersion ?? null,
            modloader:   input.modloader ?? null,
        },
        update: {
            packName:    input.packName,
            versionName: input.versionName,
            mcVersion:   input.mcVersion ?? null,
            modloader:   input.modloader ?? null,
            updatedAt:   new Date(),
        },
    });
    return record.id;
}

export interface UpsertPackFileInput {
    packVersionId:   number;
    manifestFileId?: number | null;
    fileType:        string;
    fileName:        string;
    filePath?:       string | null;
    cfProject?:      number | null;
    cfFile?:         number | null;
    sha1?:           string | null;
    status:          string;
    modId?:          number | null;
}

function providerId(value: unknown): number | null {
    if (value == null) return null;
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid CurseForge project/file ID");
    return parsed;
}

/** Upsert a single pack file record. Keyed on (packVersionId, manifestFileId). */
export async function upsertPackFile(input: UpsertPackFileInput): Promise<void> {
    const db = await getDb();
    const data = {
        packVersionId:  input.packVersionId,
        manifestFileId: input.manifestFileId ?? null,
        fileType:       input.fileType,
        fileName:       input.fileName,
        filePath:       input.filePath       ?? null,
        cfProject:      providerId(input.cfProject),
        cfFile:         providerId(input.cfFile),
        sha1:           input.sha1           ?? null,
        status:         input.status,
        modId:          input.modId          ?? null,
    };

    if (input.manifestFileId != null) {
        await db.packFile.upsert({
            where: {
                packVersionId_manifestFileId: {
                    packVersionId:  input.packVersionId,
                    manifestFileId: input.manifestFileId,
                },
            },
            create: data,
            update: {
                fileType:  data.fileType,
                fileName:  data.fileName,
                filePath:  data.filePath,
                cfProject: data.cfProject,
                cfFile:    data.cfFile,
                sha1:      data.sha1,
                status:    data.status,
                modId:     data.modId,
            },
        });
    } else {
        await db.packFile.create({ data }).catch(() => {/* ignore duplicates */});
    }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** List all known pack versions, optionally filtered by namespace and/or packId. */
export async function listPackVersions(
    namespace?: string,
    packId?: number,
): Promise<PackVersion[]> {
    const db = await getDb();
    return db.packVersion.findMany({
        where: {
            ...(namespace !== undefined ? { namespace } : {}),
            ...(packId    !== undefined ? { packId }    : {}),
        },
        orderBy: { syncedAt: "desc" },
    });
}

/** List all files recorded for a specific pack version DB id. */
export async function listPackFiles(packVersionId: number): Promise<PackFile[]> {
    const db = await getDb();
    return db.packFile.findMany({
        where:   { packVersionId },
        orderBy: [{ fileType: "asc" }, { fileName: "asc" }],
    });
}

export type PackMembership = PackVersion & {
    fileName: string;
    fileType: string;
    status:   string;
    cfProject?: number | null;
    cfFile?:    number | null;
};

/** Find every pack version that contains a specific Mod (by DB id). */
export async function findPacksForMod(modId: number): Promise<PackMembership[]> {
    const db = await getDb();
    const files = await db.packFile.findMany({
        where:   { modId },
        include: { packVersion: true },
    });
    return files.map((f) => ({
        ...f.packVersion,
        fileName:  f.fileName,
        fileType:  f.fileType,
        status:    f.status,
        cfProject: f.cfProject,
        cfFile:    f.cfFile,
    }));
}

/** Find every pack version that contains a file with a given CurseForge project id. */
export async function findPacksForCfProject(cfProject: number): Promise<PackMembership[]> {
    const db = await getDb();
    const files = await db.packFile.findMany({
        where:   { cfProject },
        include: { packVersion: true },
    });
    return files.map((f) => ({
        ...f.packVersion,
        fileName:  f.fileName,
        fileType:  f.fileType,
        status:    f.status,
        cfProject: f.cfProject,
        cfFile:    f.cfFile,
    }));
}

/** Resolve a PackVersion record by namespace + packId + versionId. */
export async function findPackVersion(
    namespace: string,
    packId: number,
    versionId: number,
): Promise<PackVersion | null> {
    const db = await getDb();
    return db.packVersion.findUnique({
        where: {
            namespace_packId_versionId: { namespace, packId, versionId },
        },
    });
}
