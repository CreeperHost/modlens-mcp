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
import { isOllamaAvailable, embed, batchEmbed } from "../embeddings.js";
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
 * @param force       Skip cache read and recompute (still writes result to cache).
 * @param semantic    Enrich with Ollama embedding similarity (requires Ollama + index_semantic).
 * @param cache       When false, skip both reading and writing the DB cache (default true).
 */
export async function diffMcVersionsDetailed(
    versionA: string,
    versionB: string,
    packages?: string[],
    maxClasses = 200,
    force = false,
    semantic = false,
    cache = true,
): Promise<VersionDiffResult> {
    validateVersion(versionA);
    validateVersion(versionB);

    const pkgHash = buildPackagesHash(packages);

    if (!force && cache) {
        const cached = await readCachedDiff(versionA, versionB, pkgHash);
        if (cached) {
            return { ...cached, changed: cached.changed.slice(0, maxClasses) };
        }
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
        changed,  // full array stored in cache; sliced at return
    };

    if (semantic && await isOllamaAvailable()) {
        result.changed = await enrichWithSemanticScores(result.changed, versionA, versionB);
    }

    if (cache) {
        await writeCachedDiff(versionA, versionB, pkgHash, result);
    }

    return { ...result, changed: result.changed.slice(0, maxClasses) };
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

    // Pass 1: batch-embed all class names in one Ollama request, then find matching rows
    const dotNames = diffs.map((d) => d.className.replace(/\//g, "."));
    let embeddings: number[][] = [];
    try {
        embeddings = await batchEmbed(dotNames);
    } catch {
        // Ollama error — return diffs unchanged
        return diffs.map((d) => ({ ...d, semanticSimilarity: null }));
    }

    // Pass 1: fire all 2×N vector lookups in parallel, then collect pairs
    const lookups = await Promise.all(
        embeddings.map((queryVec, i) => queryVec
            ? Promise.all([
                embRepo.searchSourceByVector(queryVec, idA, 1).catch(() => [] as any[]),
                embRepo.searchSourceByVector(queryVec, idB, 1).catch(() => [] as any[]),
            ])
            : Promise.resolve([[] as any[], [] as any[]])
        )
    );

    const pairs: Array<{ diffIdx: number; aId: number; bId: number }> = [];
    for (let i = 0; i < diffs.length; i++) {
        const diff = diffs[i];
        const dotName = dotNames[i];
        const [rowsA, rowsB] = lookups[i] as [any[], any[]];
        const hitA = rowsA.find((r) => r.class_name === diff.className || r.class_name === dotName);
        const hitB = rowsB.find((r) => r.class_name === diff.className || r.class_name === dotName);
        if (hitA && hitB) pairs.push({ diffIdx: i, aId: hitA.id, bId: hitB.id });
    }

    // Pass 2: batch all similarity computations in one DB round-trip
    const simMap = await batchSimilarities(pairs, backend, "mc_source_files");

    // Pass 3: assign scores back
    const enriched = diffs.map((d) => ({ ...d, semanticSimilarity: null as number | null }));
    for (const { diffIdx, aId, bId } of pairs) {
        enriched[diffIdx].semanticSimilarity = simMap.get(`${aId}:${bId}`) ?? null;
    }
    return enriched;
}

/**
 * Batch-compute cosine similarities for multiple id pairs against a source table.
 * SQLite: opens ONE connection and fetches all needed embeddings in a single query.
 * PG: single unnest-based JOIN query.
 * Returns a Map keyed by "aId:bId".
 */
async function batchSimilarities(
    pairs: Array<{ aId: number; bId: number }>,
    backend: string,
    table: string,
): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (pairs.length === 0) return out;

    if (backend !== "sqlite") {
        const db = await getDb();
        const aIds = pairs.map((p) => p.aId);
        const bIds = pairs.map((p) => p.bId);
        const rows = await db.$queryRawUnsafe<Array<{ a_id: number; b_id: number; sim: number }>>(
            `SELECT p.a_id, p.b_id, (1 - (a.embedding <=> b.embedding))::float AS sim
             FROM unnest($1::int[], $2::int[]) AS p(a_id, b_id)
             JOIN ${table} a ON a.id = p.a_id AND a.embedding IS NOT NULL
             JOIN ${table} b ON b.id = p.b_id AND b.embedding IS NOT NULL`,
            aIds, bIds,
        );
        for (const { a_id, b_id, sim } of rows) out.set(`${a_id}:${b_id}`, sim);
    } else {
        const Database = (await import("better-sqlite3")).default;
        const url = process.env.DATABASE_URL ?? "";
        const dbPath = url.replace(/^file:\/\//, "").replace(/^file:/, "");
        const db = new Database(dbPath, { readonly: true });
        const allIds = [...new Set(pairs.flatMap((p) => [p.aId, p.bId]))];
        const placeholders = allIds.map(() => "?").join(",");
        const rows = db.prepare(`SELECT id, embedding FROM ${table} WHERE id IN (${placeholders})`)
            .all(...allIds) as Array<{ id: number; embedding: Buffer | null }>;
        db.close();
        const embMap = new Map(rows.map((r) => [r.id, r.embedding]));
        for (const { aId, bId } of pairs) {
            const ea = embMap.get(aId);
            const eb = embMap.get(bId);
            out.set(`${aId}:${bId}`, ea && eb ? cosineSimilarityBlob(ea, eb) : null);
        }
    }
    return out;
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
        if (cached) {
            return { ...cached, changed: cached.changed.slice(0, maxClasses) };
        }
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
        changed,  // full array stored in cache; sliced at return
    };

    const result: ModVersionDiffResult = {
        ...base,
        modA: { id: dbIdA, modId: modA.modId, version: modA.version },
        modB: { id: dbIdB, modId: modB.modId, version: modB.version },
    };

    if (semantic && await isOllamaAvailable()) {
        result.changed = await enrichModWithSemanticScores(result.changed, dbIdA, dbIdB);
    }

    if (useCache) {
        await writeCachedModDiff(dbIdA, dbIdB, pkgHash, result);
    }

    return { ...result, changed: result.changed.slice(0, maxClasses) };
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

    // Pass 1: batch-embed all class names in one Ollama request, then find matching rows
    const dotNames = diffs.map((d) => d.className.replace(/\//g, "."));
    let embeddings: number[][] = [];
    try {
        embeddings = await batchEmbed(dotNames);
    } catch {
        return diffs.map((d) => ({ ...d, semanticSimilarity: null }));
    }

    // Pass 1: fire all 2×N vector lookups in parallel, then collect pairs
    const lookups = await Promise.all(
        embeddings.map((queryVec, i) => queryVec
            ? Promise.all([
                embRepo.searchModSourceByVector(queryVec, dbIdA, 1).catch(() => [] as any[]),
                embRepo.searchModSourceByVector(queryVec, dbIdB, 1).catch(() => [] as any[]),
            ])
            : Promise.resolve([[] as any[], [] as any[]])
        )
    );

    const pairs: Array<{ diffIdx: number; aId: number; bId: number }> = [];
    for (let i = 0; i < diffs.length; i++) {
        const diff = diffs[i];
        const dotName = dotNames[i];
        const [rowsA, rowsB] = lookups[i] as [any[], any[]];
        const hitA = rowsA.find((r) => r.class_name === diff.className || r.class_name === dotName);
        const hitB = rowsB.find((r) => r.class_name === diff.className || r.class_name === dotName);
        if (hitA && hitB) pairs.push({ diffIdx: i, aId: hitA.id, bId: hitB.id });
    }

    // Pass 2: batch all similarity computations in one DB round-trip
    const simMap = await batchSimilarities(pairs, backend, "mod_source_files");

    // Pass 3: assign scores back
    const enriched = diffs.map((d) => ({ ...d, semanticSimilarity: null as number | null }));
    for (const { diffIdx, aId, bId } of pairs) {
        enriched[diffIdx].semanticSimilarity = simMap.get(`${aId}:${bId}`) ?? null;
    }
    return enriched;
}
