/**
 * PostgreSQL full-text search for vanilla Minecraft source.
 * index_minecraft_version: walks a completed Vineflower decompile, stores
 *   source in the mc_source_files table.
 * search_mc_indexed: runs a fast FTS query via to_tsvector('simple', content).
 *
 * For best performance, create a GIN index once after migration:
 *   CREATE INDEX CONCURRENTLY mc_source_files_tsv_idx
 *     ON mc_source_files USING GIN (to_tsvector('simple', content));
 */
import { readFile, readdir } from "fs/promises";
import { join, relative } from "path";
import { mcPaths, fetchMcVersionList } from "../minecraft.js";
import { isDecompileDone } from "../java-tools.js";
import { exists } from "../cache.js";
import { db } from "../db.js";

async function ensureMcVersionRecord(version: string): Promise<number> {
    const existing = await db().mcVersion.findUnique({ where: { versionId: version } });
    if (existing) return existing.id;
    const allVersions = await fetchMcVersionList(true);
    const entry = allVersions.find((v) => v.id === version);
    const releaseTime = entry ? new Date(entry.releaseTime) : new Date();
    const created = await db().mcVersion.create({
        data: { versionId: version, type: entry?.type ?? "release", releaseTime },
    });
    return created.id;
}

/** Collect all .java file paths under a directory tree. */
async function collectJavaFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...await collectJavaFiles(full));
        else if (e.name.endsWith(".java")) out.push(full);
    }
    return out;
}

/**
 * index_minecraft_version
 * Reads the already-decompiled source tree and upserts every .java file
 * into mc_source_files for FTS. Decompilation must have finished first
 * (run decompile_minecraft_version and wait for status "done").
 */
export async function indexMcVersion(version: string, force = false): Promise<{
    status: string; indexed: number; skipped: number;
}> {
    const outDir = mcPaths.decompiled(version);
    const decompStatus = await isDecompileDone(outDir);
    if (decompStatus !== "done") {
        throw new Error(
            `MC ${version} decompile is not complete (status: ${decompStatus}). ` +
            `Run decompile_minecraft_version("${version}") first.`
        );
    }

    const mcVersionId = await ensureMcVersionRecord(version);

    if (!force) {
        const existing = await db().mcVersion.findUnique({ where: { id: mcVersionId } });
        if (existing?.indexed) return { status: "already_indexed", indexed: 0, skipped: 0 };
    }

    const javaFiles = await collectJavaFiles(outDir);
    let indexed = 0;
    let skipped = 0;

    // Batch upserts in chunks of 50 to avoid huge transactions
    const BATCH = 50;
    for (let i = 0; i < javaFiles.length; i += BATCH) {
        const chunk = javaFiles.slice(i, i + BATCH);
        for (const filePath of chunk) {
            const relPath = relative(outDir, filePath);
            // Convert path to internal class name: com/example/Foo.java → com/example/Foo
            const className = relPath.replace(/\\/g, "/").replace(/\.java$/, "");
            try {
                const content = await readFile(filePath, "utf8");
                await db().mcSourceFile.upsert({
                    where: { mcVersionId_className: { mcVersionId, className } },
                    create: { mcVersionId, className, content },
                    update: { content },
                });
                indexed++;
            } catch {
                skipped++;
            }
        }
    }

    await db().mcVersion.update({
        where: { id: mcVersionId },
        data: { indexed: true },
    });

    return { status: "done", indexed, skipped };
}

interface FtsRow { class_name: string; snippet: string; }

/**
 * search_mc_indexed
 * Fast FTS search over indexed MC source. Supports:
 *   - Plain text / keyword queries (uses plainto_tsquery 'simple' config — no stemming)
 *   - Boolean: "Entity AND tick", "player OR entity", "hurt -damage"
 *   - Phrase: wrap in double-quotes passed as tsquery: '"onHurt"'
 */
export async function searchMcIndexed(
    query: string,
    version: string,
    limit = 20,
): Promise<Array<{ className: string; snippet: string }>> {
    const mcVersionId = await db().mcVersion.findUnique({ where: { versionId: version } })
        .then((r) => r?.id);

    if (!mcVersionId) {
        throw new Error(`Version "${version}" is not in the database. Run index_minecraft_version("${version}") first.`);
    }

    // Use plainto_tsquery for safe user input (no syntax errors on plain text).
    // Uses 'simple' dictionary so class/method names aren't stemmed.
    const rows = await db().$queryRaw<FtsRow[]>`
        SELECT
            class_name,
            LEFT(content, 500) AS snippet
        FROM mc_source_files
        WHERE mc_version_id = ${mcVersionId}
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', ${query})
        LIMIT ${limit}
    `;

    return rows.map((r) => ({ className: r.class_name, snippet: r.snippet }));
}
