/**
 * PostgreSQL full-text search for vanilla Minecraft source.
 * index_minecraft_version: walks a completed Vineflower decompile, stores
 *   source in the mc_source_files table.
 * search_mc_indexed: runs a fast FTS query via to_tsvector('simple', content).
 *
 * The GIN index is created automatically by `npm run db:setup`.
 * (scripts/create-fts-index.mjs — runs after prisma migrate deploy)
 */
import { readFile, readdir } from "fs/promises";
import { join, relative } from "path";
import { mcPaths, fetchMcVersionList } from "../minecraft.js";
import { isDecompileDone } from "../java-tools.js";
import { exists } from "../cache.js";
import { ensureMcVersion, findMcVersionById, findMcVersionByVersionId, updateMcVersion, upsertMcSourceFile, searchMcSourceFiles } from "../repositories/mcVersion.js";

async function ensureMcVersionRecord(version: string): Promise<number> {
    return ensureMcVersion(version);
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
        const existing = await findMcVersionById(mcVersionId);
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
                await upsertMcSourceFile(mcVersionId, className, content);
                indexed++;
            } catch {
                skipped++;
            }
        }
    }

    await updateMcVersion(mcVersionId, { indexed: true });

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
    const row = await findMcVersionByVersionId(version);
    if (!row) {
        throw new Error(`Version "${version}" is not in the database. Run index_minecraft_version("${version}") first.`);
    }
    return searchMcSourceFiles(row.id, query, limit);
}

/**
 * Returns true if the FTS index has been built for this MC version.
 * Checks `indexed` flag on the McVersion row.
 */
export async function isMcVersionIndexed(version: string): Promise<boolean> {
    const row = await findMcVersionByVersionId(version);
    return row?.indexed === true;
}
