/**
 * Repository layer for the McVersion and McSourceFile tables.
 * All Prisma queries against these tables live here.
 */
import { getDb } from "../db.js";
import { fetchMcVersionList } from "../minecraft.js";
import type { McVersion, Prisma } from "@prisma/client";
import { ftsSearchSource } from "../search-adapter.js";

// ── McVersion queries ─────────────────────────────────────────────────────────

/**
 * Find-or-create an McVersion record by versionId.
 * Returns the numeric DB id. Consolidates the duplicate ensureMcVersionRecord
 * pattern that was independently duplicated in vanilla.ts and mc-fts.ts.
 */
export async function ensureMcVersion(version: string): Promise<number> {
    const db = await getDb();
    const existing = await db.mcVersion.findUnique({ where: { versionId: version } });
    if (existing) return existing.id;

    const allVersions = await fetchMcVersionList(true);
    const entry = allVersions.find((v) => v.id === version);
    const releaseTime = entry ? new Date(entry.releaseTime) : new Date();
    const type = entry?.type ?? "release";

    const created = await db.mcVersion.create({
        data: { versionId: version, type, releaseTime },
    });
    return created.id;
}

export async function findMcVersionByVersionId(versionId: string): Promise<McVersion | null> {
    const db = await getDb();
    return db.mcVersion.findUnique({ where: { versionId } });
}

export async function findMcVersionById(id: number): Promise<McVersion | null> {
    const db = await getDb();
    return db.mcVersion.findUnique({ where: { id } });
}

export async function updateMcVersion(id: number, data: Prisma.McVersionUpdateInput): Promise<McVersion> {
    const db = await getDb();
    return db.mcVersion.update({ where: { id }, data });
}

// ── McSourceFile queries ──────────────────────────────────────────────────────

export async function upsertMcSourceFile(
    mcVersionId: number,
    className: string,
    content: string,
): Promise<void> {
    const db = await getDb();
    await db.mcSourceFile.upsert({
        where: { mcVersionId_className: { mcVersionId, className } },
        create: { mcVersionId, className, content },
        update: { content },
    });
}

interface FtsRow { class_name: string; snippet: string; }

export async function searchMcSourceFiles(
    mcVersionId: number,
    query: string,
    limit: number,
): Promise<Array<{ className: string; snippet: string }>> {
    return ftsSearchSource(mcVersionId, query, limit);
}
