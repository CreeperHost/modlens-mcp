/**
 * AST-level version diff for Minecraft source.
 * Uses JarIndex data (bytecode-extracted method/field descriptors) to produce
 * structured ClassDiff results with breaking-change classification.
 * Cache layer stores computed diffs in McVersionDiff (Prisma, both PG + SQLite).
 * Semantic scoring (optional) uses existing Ollama + pgvector/sqlite-vec pipeline.
 */
import { createHash } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { getMcJarPath, mcPaths } from "../minecraft.js";
import { indexJar, type JarIndex } from "../java-tools.js";
import { descriptorToSimpleType, accessStr, type ClassInfo } from "../access-flags.js";
import { exists, ensureDir } from "../cache.js";
import { validateVersion } from "../validate.js";
import { getDb } from "../db.js";
import { detectBackend } from "../db-backend.js";
import { isOllamaAvailable, embed } from "../embeddings.js";
import { ensureMcVersion } from "../repositories/mcVersion.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChangeKind =
    | "method_added" | "method_removed" | "method_signature_changed"
    | "field_added"  | "field_removed"  | "field_type_changed"
    | "superclass_changed" | "interface_added" | "interface_removed"
    | "access_changed";

export interface MethodChange {
    name: string;
    descriptor: string;
    access: number;
    accessStr: string;
}

export interface MethodSignatureChange {
    name: string;
    from: string;
    to: string;
    access: number;
}

export interface FieldChange {
    name: string;
    descriptor: string;
    simpleType: string;
    access: number;
    accessStr: string;
}

export interface FieldTypeChange {
    name: string;
    from: string;
    to: string;
    fromSimple: string;
    toSimple: string;
}

export interface ClassDiff {
    className: string;
    superChanged: boolean;
    superFrom: string | null;
    superTo: string | null;
    interfaces: { added: string[]; removed: string[] };
    methods: {
        added: MethodChange[];
        removed: MethodChange[];
        signatureChanged: MethodSignatureChange[];
    };
    fields: {
        added: FieldChange[];
        removed: FieldChange[];
        typeChanged: FieldTypeChange[];
    };
    hasBreakingChange: boolean;
    /** Cosine similarity 0–1 between the two versions' source embeddings. null = unavailable. */
    semanticSimilarity: number | null;
}

export interface VersionDiffResult {
    versionA: string;
    versionB: string;
    packages: string[] | null;
    summary: {
        classesAdded: number;
        classesRemoved: number;
        classesChanged: number;
        breakingChanges: number;
    };
    added: string[];
    removed: string[];
    changed: ClassDiff[];
}

// ── Breaking change classification ───────────────────────────────────────────

/**
 * Returns true if a change of this kind on a member with the given access flags
 * constitutes a breaking API change.
 */
export function classifyBreaking(kind: ChangeKind | string, accessFlags: number): boolean {
    const isPublicOrProtected = !!(accessFlags & 0x0001) || !!(accessFlags & 0x0004);
    switch (kind) {
        case "method_removed":
        case "method_signature_changed":
        case "field_removed":
        case "field_type_changed":
            return isPublicOrProtected;
        case "superclass_changed":
        case "interface_removed":
            return true;
        case "access_changed":
            return isPublicOrProtected;
        default:
            return false;
    }
}

// ── Single-class diff ─────────────────────────────────────────────────────────

/**
 * Compares two ClassInfo objects and returns a structured ClassDiff.
 * Does NOT populate semanticSimilarity (caller does that separately).
 */
export function diffClassIndex(a: ClassInfo, b: ClassInfo): ClassDiff {
    // Methods: key by (name, descriptor) for exact match
    const aMethods = new Map<string, { name: string; descriptor: string; access: number }>();
    const bMethods = new Map<string, { name: string; descriptor: string; access: number }>();
    for (const m of a.methods ?? []) aMethods.set(`${m.name}::${m.descriptor}`, m);
    for (const m of b.methods ?? []) bMethods.set(`${m.name}::${m.descriptor}`, m);

    const methodsAdded: MethodChange[] = [];
    const methodsRemoved: MethodChange[] = [];
    const methodsSigChanged: MethodSignatureChange[] = [];

    for (const [key, m] of aMethods) {
        if (!bMethods.has(key)) methodsRemoved.push({
            name: m.name, descriptor: m.descriptor, access: m.access, accessStr: accessStr(m.access),
        });
    }
    for (const [key, m] of bMethods) {
        if (!aMethods.has(key)) methodsAdded.push({
            name: m.name, descriptor: m.descriptor, access: m.access, accessStr: accessStr(m.access),
        });
    }

    // Signature change heuristic: a method with same name removed in A and added in B,
    // only when that name has exactly one unmatched entry on each side.
    const aByName = new Map<string, Array<{ name: string; descriptor: string; access: number }>>();
    const bByName = new Map<string, Array<{ name: string; descriptor: string; access: number }>>();
    for (const m of a.methods ?? []) { const arr = aByName.get(m.name) ?? []; arr.push(m); aByName.set(m.name, arr); }
    for (const m of b.methods ?? []) { const arr = bByName.get(m.name) ?? []; arr.push(m); bByName.set(m.name, arr); }

    const removedNames = new Set(methodsRemoved.map((m) => m.name));
    const addedNames   = new Set(methodsAdded.map((m) => m.name));
    for (const name of removedNames) {
        if (!addedNames.has(name)) continue;
        const fromList = (aByName.get(name) ?? []).filter((m) => !bMethods.has(`${m.name}::${m.descriptor}`));
        const toList   = (bByName.get(name) ?? []).filter((m) => !aMethods.has(`${m.name}::${m.descriptor}`));
        // Only collapse to signature change when neither version has multiple overloads for this name.
        // If A or B has >1 overload, treat each descriptor independently (removed vs added).
        const totalInA = aByName.get(name)?.length ?? 0;
        const totalInB = bByName.get(name)?.length ?? 0;
        if (fromList.length === 1 && toList.length === 1 && totalInA === 1 && totalInB === 1) {
            methodsSigChanged.push({ name, from: fromList[0].descriptor, to: toList[0].descriptor, access: fromList[0].access });
            const rIdx = methodsRemoved.findIndex((m) => m.name === name && m.descriptor === fromList[0].descriptor);
            if (rIdx !== -1) methodsRemoved.splice(rIdx, 1);
            const aIdx = methodsAdded.findIndex((m) => m.name === name && m.descriptor === toList[0].descriptor);
            if (aIdx !== -1) methodsAdded.splice(aIdx, 1);
        }
    }

    // Fields: key by name (unique within a class)
    const aFields = new Map((a.fields ?? []).map((f) => [f.name, f]));
    const bFields = new Map((b.fields ?? []).map((f) => [f.name, f]));

    const fieldsAdded: FieldChange[] = [];
    const fieldsRemoved: FieldChange[] = [];
    const fieldsTypeChanged: FieldTypeChange[] = [];

    for (const [name, f] of aFields) {
        const bf = bFields.get(name);
        if (!bf) {
            fieldsRemoved.push({ name, descriptor: f.descriptor, simpleType: descriptorToSimpleType(f.descriptor), access: f.access, accessStr: accessStr(f.access) });
        } else if (bf.descriptor !== f.descriptor) {
            fieldsTypeChanged.push({ name, from: f.descriptor, to: bf.descriptor, fromSimple: descriptorToSimpleType(f.descriptor), toSimple: descriptorToSimpleType(bf.descriptor) });
        }
    }
    for (const [name, f] of bFields) {
        if (!aFields.has(name)) fieldsAdded.push({ name, descriptor: f.descriptor, simpleType: descriptorToSimpleType(f.descriptor), access: f.access, accessStr: accessStr(f.access) });
    }

    // Superclass / interfaces
    const superChanged = a.superName !== b.superName;
    const aIfaces = new Set(a.interfaces ?? []);
    const bIfaces = new Set(b.interfaces ?? []);
    const ifacesAdded   = [...bIfaces].filter((i) => !aIfaces.has(i));
    const ifacesRemoved = [...aIfaces].filter((i) => !bIfaces.has(i));

    // Breaking change flag
    const hasBreakingChange =
        methodsRemoved.some((m) => classifyBreaking("method_removed", m.access)) ||
        methodsSigChanged.some((m) => classifyBreaking("method_signature_changed", m.access)) ||
        fieldsRemoved.some((f) => classifyBreaking("field_removed", f.access)) ||
        fieldsTypeChanged.some((f) => {
            const aField = aFields.get(f.name);
            return aField ? classifyBreaking("field_type_changed", aField.access) : false;
        }) ||
        (superChanged && classifyBreaking("superclass_changed", 0)) ||
        ifacesRemoved.length > 0;

    return {
        className: a.name,
        superChanged,
        superFrom: superChanged ? a.superName : null,
        superTo:   superChanged ? b.superName : null,
        interfaces: { added: ifacesAdded, removed: ifacesRemoved },
        methods: { added: methodsAdded, removed: methodsRemoved, signatureChanged: methodsSigChanged },
        fields:  { added: fieldsAdded, removed: fieldsRemoved, typeChanged: fieldsTypeChanged },
        hasBreakingChange,
        semanticSimilarity: null,
    };
}

// ── Index loading (cached to disk, mirrors vanilla.ts getMcIndex) ─────────────

const indexMemCache = new Map<string, JarIndex>();

async function getMcIndexCached(version: string): Promise<JarIndex> {
    if (indexMemCache.has(version)) return indexMemCache.get(version)!;
    const cachePath = mcPaths.index(version);
    if (await exists(cachePath)) {
        const data = JSON.parse(await readFile(cachePath, "utf8")) as JarIndex;
        indexMemCache.set(version, data);
        return data;
    }
    const jarPath = await getMcJarPath(version);
    const index = await indexJar(jarPath);
    await ensureDir(cachePath);
    await writeFile(cachePath, JSON.stringify(index), "utf8");
    indexMemCache.set(version, index);
    return index;
}

// ── packages hash helper ──────────────────────────────────────────────────────

function buildPackagesHash(packages: string[] | undefined): string {
    if (!packages || packages.length === 0) return "all";
    return createHash("sha1").update([...packages].sort().join("|")).digest("hex").slice(0, 12);
}

// ── DB cache helpers ──────────────────────────────────────────────────────────

async function readCachedDiff(
    versionA: string, versionB: string, pkgHash: string,
): Promise<VersionDiffResult | null> {
    try {
        const db = await getDb();
        const row = await (db as any).mcVersionDiff.findUnique({
            where: { versionA_versionB_packagesHash: { versionA, versionB, packagesHash: pkgHash } },
        });
        if (!row) return null;
        const raw = detectBackend() === "sqlite" ? JSON.parse(row.result as string) : row.result;
        return raw as VersionDiffResult;
    } catch {
        return null; // table may not exist yet in older DBs
    }
}

async function writeCachedDiff(
    versionA: string, versionB: string, pkgHash: string, result: VersionDiffResult,
): Promise<void> {
    try {
        const db = await getDb();
        const resultData = detectBackend() === "sqlite" ? JSON.stringify(result) : result;
        await (db as any).mcVersionDiff.upsert({
            where: { versionA_versionB_packagesHash: { versionA, versionB, packagesHash: pkgHash } },
            update: { result: resultData },
            create: { versionA, versionB, packagesHash: pkgHash, result: resultData },
        });
    } catch {
        // Non-fatal — result is still returned even if caching fails
    }
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Produces a detailed AST-level diff between two MC versions.
 *
 * @param versionA    Earlier version (e.g. "1.20.1")
 * @param versionB    Later version (e.g. "1.21.1")
 * @param packages    Optional slash-prefix filter (e.g. ["net/minecraft/world/entity"])
 * @param maxClasses  Cap on changed-class output (default 200). Does not affect summary counts.
 * @param force       Skip cache and recompute.
 * @param semantic    Enrich with Ollama embedding similarity (requires Ollama + index_semantic).
 */
export async function diffMcVersionsDetailed(
    versionA: string,
    versionB: string,
    packages?: string[],
    maxClasses = 200,
    force = false,
    semantic = false,
): Promise<VersionDiffResult> {
    validateVersion(versionA);
    validateVersion(versionB);

    const pkgHash = buildPackagesHash(packages);

    if (!force) {
        const cached = await readCachedDiff(versionA, versionB, pkgHash);
        if (cached) return cached;
    }

    const [indexA, indexB] = await Promise.all([
        getMcIndexCached(versionA),
        getMcIndexCached(versionB),
    ]);

    const setA = new Set(Object.keys(indexA.classes));
    const setB = new Set(Object.keys(indexB.classes));

    const inScope = (cls: string): boolean => {
        if (!packages || packages.length === 0) return true;
        return packages.some((pkg) => cls.startsWith(pkg));
    };

    const added   = [...setB].filter((c) => !setA.has(c) && inScope(c)).sort();
    const removed = [...setA].filter((c) => !setB.has(c) && inScope(c)).sort();
    const common  = [...setA].filter((c) =>  setB.has(c) && inScope(c));

    const changed: ClassDiff[] = [];
    let breakingCount = 0;

    for (const cls of common) {
        const diff = diffClassIndex(indexA.classes[cls], indexB.classes[cls]);
        const isEmpty =
            diff.methods.added.length === 0 &&
            diff.methods.removed.length === 0 &&
            diff.methods.signatureChanged.length === 0 &&
            diff.fields.added.length === 0 &&
            diff.fields.removed.length === 0 &&
            diff.fields.typeChanged.length === 0 &&
            !diff.superChanged &&
            diff.interfaces.added.length === 0 &&
            diff.interfaces.removed.length === 0;

        if (!isEmpty) {
            changed.push(diff);
            if (diff.hasBreakingChange) breakingCount++;
        }
    }

    const result: VersionDiffResult = {
        versionA, versionB,
        packages: packages ?? null,
        summary: {
            classesAdded: added.length,
            classesRemoved: removed.length,
            classesChanged: changed.length,
            breakingChanges: breakingCount,
        },
        added,
        removed,
        changed: changed.slice(0, maxClasses),
    };

    await writeCachedDiff(versionA, versionB, pkgHash, result);

    if (semantic && await isOllamaAvailable()) {
        result.changed = await enrichWithSemanticScores(result.changed, versionA, versionB);
    }

    return result;
}

// ── Semantic similarity enrichment ───────────────────────────────────────────

/**
 * For each ClassDiff, look up embeddings for its class in versionA and versionB.
 * If both are found, compute cosine similarity and set semanticSimilarity.
 */
async function enrichWithSemanticScores(
    diffs: ClassDiff[],
    versionA: string,
    versionB: string,
): Promise<ClassDiff[]> {
    const [idA, idB] = await Promise.all([
        ensureMcVersion(versionA),
        ensureMcVersion(versionB),
    ]);

    const backend = detectBackend();
    const embRepo = backend === "sqlite"
        ? await import("../repositories/embeddings-sqlite.js")
        : await import("../repositories/embeddings.js");

    const enriched: ClassDiff[] = [];

    for (const diff of diffs) {
        const dotName = diff.className.replace(/\//g, ".");
        let sim: number | null = null;
        try {
            const queryVec = await embed(dotName);
            const [rowsA, rowsB] = await Promise.all([
                embRepo.searchSourceByVector(queryVec, idA, 1),
                embRepo.searchSourceByVector(queryVec, idB, 1),
            ]);
            const hitA = rowsA.find((r) => (r as any).class_name === diff.className || (r as any).class_name === dotName);
            const hitB = rowsB.find((r) => (r as any).class_name === diff.className || (r as any).class_name === dotName);
            if (hitA && hitB) {
                sim = await crossVersionSimilarity(hitA.id, hitB.id, backend);
            }
        } catch {
            // Ollama or DB error — silently skip
        }
        enriched.push({ ...diff, semanticSimilarity: sim });
    }

    return enriched;
}

/**
 * Compute cosine similarity between the stored embedding vectors of two McSourceFile rows.
 * Returns null if either row lacks an embedding.
 */
async function crossVersionSimilarity(
    idA: number,
    idB: number,
    backend: string,
): Promise<number | null> {
    if (backend !== "sqlite") {
        const db = await getDb();
        const rows = await db.$queryRawUnsafe<Array<{ sim: number }>>(
            `SELECT (1 - (a.embedding <=> b.embedding))::float AS sim
             FROM mc_source_files a, mc_source_files b
             WHERE a.id = $1 AND b.id = $2
               AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL`,
            idA, idB,
        );
        return rows[0]?.sim ?? null;
    } else {
        const Database = (await import("better-sqlite3")).default;
        const url = process.env.DATABASE_URL ?? "";
        const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const db = new Database(path);
        const rowA = db.prepare(`SELECT embedding FROM mc_source_files WHERE id = ?`).get(idA) as { embedding: Buffer } | undefined;
        const rowB = db.prepare(`SELECT embedding FROM mc_source_files WHERE id = ?`).get(idB) as { embedding: Buffer } | undefined;
        db.close();
        if (!rowA?.embedding || !rowB?.embedding) return null;
        return cosineSimilarityBlob(rowA.embedding, rowB.embedding);
    }
}

function cosineSimilarityBlob(a: Buffer, b: Buffer): number {
    const len = Math.min(a.length, b.length) >> 2;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
        const va = a.readFloatLE(i * 4);
        const vb = b.readFloatLE(i * 4);
        dot   += va * vb;
        normA += va * va;
        normB += vb * vb;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

// ── Mod version diff ─────────────────────────────────────────────────────────

export interface ModVersionDiffResult extends VersionDiffResult {
    modA: { id: number; modId: string; version: string };
    modB: { id: number; modId: string; version: string };
}

// ── Mod diff DB cache helpers ─────────────────────────────────────────────────

async function readCachedModDiff(
    dbIdA: number, dbIdB: number, pkgHash: string,
): Promise<ModVersionDiffResult | null> {
    try {
        const db = await getDb();
        const row = await (db as any).modVersionDiff.findUnique({
            where: { modDbIdA_modDbIdB_packagesHash: { modDbIdA: dbIdA, modDbIdB: dbIdB, packagesHash: pkgHash } },
        });
        if (!row) return null;
        const raw = detectBackend() === "sqlite" ? JSON.parse(row.result as string) : row.result;
        return raw as ModVersionDiffResult;
    } catch {
        return null;
    }
}

async function writeCachedModDiff(
    dbIdA: number, dbIdB: number, pkgHash: string, result: ModVersionDiffResult,
): Promise<void> {
    try {
        const db = await getDb();
        const resultData = detectBackend() === "sqlite" ? JSON.stringify(result) : result;
        await (db as any).modVersionDiff.upsert({
            where: { modDbIdA_modDbIdB_packagesHash: { modDbIdA: dbIdA, modDbIdB: dbIdB, packagesHash: pkgHash } },
            update: { result: resultData },
            create: { modDbIdA: dbIdA, modDbIdB: dbIdB, packagesHash: pkgHash, result: resultData },
        });
    } catch {
        // Non-fatal
    }
}

/**
 * Produces a detailed AST-level diff between two ingested mod versions.
 * Uses the same ClassDiff / breaking-change logic as diffMcVersionsDetailed.
 *
 * @param dbIdA      DB id of the older mod version
 * @param dbIdB      DB id of the newer mod version
 * @param packages   Optional slash-prefix filter (e.g. ["com/example/mymod"])
 * @param maxClasses Cap on changed-class output (default 200)
 * @param semantic   Enrich with Ollama embedding similarity (requires mod index_semantic)
 * @param cache      When true: read from DB cache first, write result to DB after compute
 * @param force      When true (implies cache=true): skip cache read, recompute, write to cache
 */
export async function diffModVersionsDetailed(
    dbIdA: number,
    dbIdB: number,
    packages?: string[],
    maxClasses = 200,
    semantic = false,
    cache = false,
    force = false,
): Promise<ModVersionDiffResult> {
    const { findModById } = await import("../repositories/mod.js");
    const [modA, modB] = await Promise.all([findModById(dbIdA), findModById(dbIdB)]);
    if (!modA) throw new Error(`Mod #${dbIdA} not found`);
    if (!modB) throw new Error(`Mod #${dbIdB} not found`);

    const useCache = cache || force;
    const pkgHash = buildPackagesHash(packages);

    if (useCache && !force) {
        const cached = await readCachedModDiff(dbIdA, dbIdB, pkgHash);
        if (cached) return cached;
    }

    const [indexA, indexB] = await Promise.all([
        indexJar(modA.jarPath),
        indexJar(modB.jarPath),
    ]);

    const setA = new Set(Object.keys(indexA.classes));
    const setB = new Set(Object.keys(indexB.classes));

    const inScope = (cls: string): boolean => {
        if (!packages || packages.length === 0) return true;
        return packages.some((pkg) => cls.startsWith(pkg));
    };

    const added   = [...setB].filter((c) => !setA.has(c) && inScope(c)).sort();
    const removed = [...setA].filter((c) => !setB.has(c) && inScope(c)).sort();
    const common  = [...setA].filter((c) =>  setB.has(c) && inScope(c));

    const changed: ClassDiff[] = [];
    let breakingCount = 0;

    for (const cls of common) {
        const diff = diffClassIndex(indexA.classes[cls], indexB.classes[cls]);
        const isEmpty =
            diff.methods.added.length === 0 &&
            diff.methods.removed.length === 0 &&
            diff.methods.signatureChanged.length === 0 &&
            diff.fields.added.length === 0 &&
            diff.fields.removed.length === 0 &&
            diff.fields.typeChanged.length === 0 &&
            !diff.superChanged &&
            diff.interfaces.added.length === 0 &&
            diff.interfaces.removed.length === 0;

        if (!isEmpty) {
            changed.push(diff);
            if (diff.hasBreakingChange) breakingCount++;
        }
    }

    const base: VersionDiffResult = {
        versionA: modA.version,
        versionB: modB.version,
        packages: packages ?? null,
        summary: {
            classesAdded: added.length,
            classesRemoved: removed.length,
            classesChanged: changed.length,
            breakingChanges: breakingCount,
        },
        added,
        removed,
        changed: changed.slice(0, maxClasses),
    };

    const result: ModVersionDiffResult = {
        ...base,
        modA: { id: dbIdA, modId: modA.modId, version: modA.version },
        modB: { id: dbIdB, modId: modB.modId, version: modB.version },
    };

    if (useCache) {
        await writeCachedModDiff(dbIdA, dbIdB, pkgHash, result);
    }

    if (semantic && await isOllamaAvailable()) {
        result.changed = await enrichModWithSemanticScores(result.changed, dbIdA, dbIdB);
    }

    return result;
}

/**
 * Semantic similarity enrichment for mod source files.
 * Uses mod_source_files embeddings (mod index_semantic must have been run first).
 */
async function enrichModWithSemanticScores(
    diffs: ClassDiff[],
    dbIdA: number,
    dbIdB: number,
): Promise<ClassDiff[]> {
    const backend = detectBackend();
    const embRepo = backend === "sqlite"
        ? await import("../repositories/embeddings-sqlite.js")
        : await import("../repositories/embeddings.js");

    const enriched: ClassDiff[] = [];

    for (const diff of diffs) {
        const dotName = diff.className.replace(/\//g, ".");
        let sim: number | null = null;
        try {
            const queryVec = await embed(dotName);
            const [rowsA, rowsB] = await Promise.all([
                embRepo.searchModSourceByVector(queryVec, dbIdA, 1),
                embRepo.searchModSourceByVector(queryVec, dbIdB, 1),
            ]);
            const hitA = rowsA.find((r) => (r as any).class_name === diff.className || (r as any).class_name === dotName);
            const hitB = rowsB.find((r) => (r as any).class_name === diff.className || (r as any).class_name === dotName);
            if (hitA && hitB) {
                sim = await crossModVersionSimilarity(hitA.id, hitB.id, backend);
            }
        } catch {
            // Ollama or DB error — silently skip
        }
        enriched.push({ ...diff, semanticSimilarity: sim });
    }

    return enriched;
}

/**
 * Compute cosine similarity between two mod_source_files rows' embeddings.
 */
async function crossModVersionSimilarity(
    idA: number,
    idB: number,
    backend: string,
): Promise<number | null> {
    if (backend !== "sqlite") {
        const db = await getDb();
        const rows = await db.$queryRawUnsafe<Array<{ sim: number }>>(
            `SELECT (1 - (a.embedding <=> b.embedding))::float AS sim
             FROM mod_source_files a, mod_source_files b
             WHERE a.id = $1 AND b.id = $2
               AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL`,
            idA, idB,
        );
        return rows[0]?.sim ?? null;
    } else {
        const Database = (await import("better-sqlite3")).default;
        const url = process.env.DATABASE_URL ?? "";
        const path = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const db = new Database(path);
        const rowA = db.prepare(`SELECT embedding FROM mod_source_files WHERE id = ?`).get(idA) as { embedding: Buffer } | undefined;
        const rowB = db.prepare(`SELECT embedding FROM mod_source_files WHERE id = ?`).get(idB) as { embedding: Buffer } | undefined;
        db.close();
        if (!rowA?.embedding || !rowB?.embedding) return null;
        return cosineSimilarityBlob(rowA.embedding, rowB.embedding);
    }
}
