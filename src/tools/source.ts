import { db } from "../db.js";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import { exists } from "../cache.js";
import { decompileMod } from "./ingest.js";
import { decompileClass as decompileClassJava } from "../java-tools.js";
import { paths } from "../cache.js";

async function getDecompPath(dbId: number): Promise<string> {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    if (mod.decompPath && await exists(mod.decompPath)) return mod.decompPath;
    // Auto-decompile on demand
    return decompileMod(dbId);
}

export async function getModSource(dbId: number, path?: string): Promise<string> {
    const decompPath = await getDecompPath(dbId);
    if (!path) {
        // Directory listing
        const entries = await readdir(decompPath, { recursive: true });
        return entries.filter((e) => e.endsWith(".java")).join("\n");
    }
    const filePath = join(decompPath, path);
    if (!(await exists(filePath))) throw new Error(`File not found: ${path}`);
    const s = await stat(filePath);
    if (s.isDirectory()) {
        const entries = await readdir(filePath);
        return entries.join("\n");
    }
    const content = await readFile(filePath, "utf8");
    return content.slice(0, 50_000); // cap at 50KB
}

export async function searchSource(query: string, dbId?: number, isRegex = false, limit = 50): Promise<Array<{ file: string; line: number; text: string; }>> {
    const mods = dbId
        ? [await db().mod.findUnique({ where: { id: dbId } })]
        : await db().mod.findMany({ where: { decompiled: true } });

    const results: Array<{ file: string; line: number; text: string; }> = [];
    const regex = isRegex ? new RegExp(query, "i") : null;

    for (const mod of mods) {
        if (!mod?.decompPath) continue;
        await searchDir(mod.decompPath, mod.decompPath, query, regex, results, limit);
        if (results.length >= limit) break;
    }
    return results.slice(0, limit);
}

async function searchDir(
    base: string,
    dir: string,
    query: string,
    regex: RegExp | null,
    results: Array<{ file: string; line: number; text: string; }>,
    limit: number
): Promise<void> {
    if (results.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (results.length >= limit) break;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            await searchDir(base, fullPath, query, regex, results, limit);
        } else if (entry.name.endsWith(".java")) {
            const content = await readFile(fullPath, "utf8").catch(() => "");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const matches = regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase());
                if (matches) {
                    results.push({ file: relative(base, fullPath), line: i + 1, text: line.trim().slice(0, 200) });
                    if (results.length >= limit) break;
                }
            }
        }
    }
}

export async function decompileModClass(dbId: number, className: string): Promise<string> {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    const internal = className.replace(/\./g, "/");
    const outDir = join(paths.decompiled(mod.modId, mod.version), "classes");
    return decompileClassJava(mod.jarPath, internal, outDir);
}
