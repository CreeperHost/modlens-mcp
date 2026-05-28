import { resolve, sep } from "path";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { platform } from "os";

// ── WSL path normalization ────────────────────────────────────────────────────

/**
 * Normalizes a path that may have been typed from a WSL shell or a Windows
 * shell so both work transparently.
 *
 * On Windows:
 *   /mnt/c/foo/bar.jar  →  C:/foo/bar.jar
 *   /mnt/wsl/foo.jar    →  left as-is (no drive letter, unlikely to be valid Win path)
 *   C:\foo\bar.jar      →  left as-is (already Windows)
 *
 * On Linux/macOS: returned unchanged (WSL paths are native there).
 */
export function normalizeJarPath(p: string): string {
    if (platform() !== "win32") return p;
    const m = p.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
    if (m) {
        const drive = m[1].toUpperCase();
        const rest = (m[2] ?? "").replace(/\//g, "\\");
        return `${drive}:${rest || "\\"}`;
    }
    return p;
}

// ── Path traversal guard ──────────────────────────────────────────────────────

/**
 * Validate that `untrusted` resolves to a path inside `base`.
 * Throws if it would escape (path traversal attempt).
 * Returns the resolved absolute path on success.
 */
export function validatePath(untrusted: string, base: string): string {
    const resolvedBase = resolve(base);
    const resolvedTarget = resolve(base, untrusted);

    // Allow empty / "." — both resolve to base itself
    if (resolvedTarget === resolvedBase) return resolvedTarget;

    const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
    if (!resolvedTarget.startsWith(baseWithSep)) {
        throw new Error(`Path traversal attempt rejected: '${untrusted}'`);
    }
    return resolvedTarget;
}

// ── ReDoS guard ───────────────────────────────────────────────────────────────

const MAX_REGEX_LENGTH = 500;

/**
 * Compile a user-supplied regex string safely.
 * Throws if the pattern is too long or fails to compile.
 */
export function safeRegex(pattern: string, flags = "i"): RegExp {
    if (pattern.length > MAX_REGEX_LENGTH) {
        throw new Error(`Regex pattern too long (max ${MAX_REGEX_LENGTH} characters)`);
    }
    try {
        return new RegExp(pattern, flags);
    } catch (e) {
        throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// ── SHA-512 integrity helpers ─────────────────────────────────────────────────

/**
 * Compute the SHA-512 hex digest of a file on disk.
 */
export async function fileSha512(filePath: string): Promise<string> {
    const buf = await readFile(filePath);
    return createHash("sha512").update(buf).digest("hex");
}

/**
 * Verify a file's SHA-512 against an expected value.
 * Throws `HashMismatchError` if they differ.
 */
export class HashMismatchError extends Error {
    constructor(filePath: string, expected: string, actual: string) {
        super(`SHA-512 mismatch for ${filePath}:\n  expected: ${expected}\n  actual:   ${actual}`);
        this.name = "HashMismatchError";
    }
}

export async function verifyFileHash(filePath: string, expectedSha512: string): Promise<void> {
    const actual = await fileSha512(filePath);
    if (actual !== expectedSha512.toLowerCase()) {
        throw new HashMismatchError(filePath, expectedSha512.toLowerCase(), actual);
    }
}

// ── Graph bundle validation ───────────────────────────────────────────────────

const PROMPT_INJECTION_PATTERNS = [
    /(ignore|disregard|forget)\s+(all|previous|prior|above|system)/i,
    /(system\s*prompt|you\s*are\s*now|admin\s*mode|execute|run\s*command|eval\()/i,
    /(curl|wget|bash|powershell|rm\s+-rf|del\s+\/)/i,
];

const CONTROL_CHAR_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

interface ValidationResult {
    valid: boolean;
    reason?: string;
    flaggedEntries?: string[];
}

function checkStringField(value: unknown, maxLen: number, fieldName: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return `${fieldName} must be a string`;
    if (value.length > maxLen) return `${fieldName} exceeds max length (${maxLen})`;
    if (CONTROL_CHAR_REGEX.test(value)) return `${fieldName} contains control characters`;
    return null;
}

function scanForPromptInjection(text: string): boolean {
    return PROMPT_INJECTION_PATTERNS.some(p => p.test(text));
}

/**
 * Validate a graph.json bundle for security issues.
 * Checks schema, string lengths, prompt injection, and size limits.
 */
export function validateGraphBundle(graph: unknown): ValidationResult {
    if (!graph || typeof graph !== "object") {
        return { valid: false, reason: "graph must be an object" };
    }

    const g = graph as Record<string, unknown>;

    // Reject __proto__ pollution
    if (Object.prototype.hasOwnProperty.call(g, "__proto__") ||
        Object.prototype.hasOwnProperty.call(g, "constructor") ||
        Object.prototype.hasOwnProperty.call(g, "prototype")) {
        return { valid: false, reason: "proto_pollution" };
    }

    const nodes = g.nodes;
    const edges = g.edges;

    if (!Array.isArray(nodes)) return { valid: false, reason: "nodes must be an array" };
    if (!Array.isArray(edges)) return { valid: false, reason: "edges must be an array" };

    // Size limits
    if (nodes.length > 500_000) return { valid: false, reason: "too many nodes (>500k)" };
    if (edges.length > 2_000_000) return { valid: false, reason: "too many edges (>2M)" };

    const flagged: string[] = [];

    // Validate nodes
    for (const node of nodes) {
        if (!node || typeof node !== "object") return { valid: false, reason: "node must be an object" };
        const n = node as Record<string, unknown>;
        if ("__proto__" in n) return { valid: false, reason: "proto_pollution in node" };

        const idErr = checkStringField(n.id, 500, "node.id");
        if (idErr) return { valid: false, reason: idErr };
        if (!n.id) return { valid: false, reason: "node missing id" };

        const typeErr = checkStringField(n.type, 100, "node.type");
        if (typeErr) return { valid: false, reason: typeErr };

        const srcErr = checkStringField(n.src, 300, "node.src");
        if (srcErr) return { valid: false, reason: srcErr };

        const communityErr = checkStringField(n.community, 1000, "node.community");
        if (communityErr) return { valid: false, reason: communityErr };

        // Scan text fields for prompt injection
        const textFields = [n.id, n.community].filter(Boolean).map(String);
        for (const text of textFields) {
            if (scanForPromptInjection(text)) {
                flagged.push(`node:${n.id}`);
            }
        }
    }

    // Validate edges
    for (const edge of edges) {
        if (!edge || typeof edge !== "object") return { valid: false, reason: "edge must be an object" };
        const e = edge as Record<string, unknown>;
        if ("__proto__" in e) return { valid: false, reason: "proto_pollution in edge" };

        const srcErr = checkStringField(e.source, 500, "edge.source");
        if (srcErr) return { valid: false, reason: srcErr };
        if (!e.source) return { valid: false, reason: "edge missing source" };

        const tgtErr = checkStringField(e.target, 500, "edge.target");
        if (tgtErr) return { valid: false, reason: tgtErr };
        if (!e.target) return { valid: false, reason: "edge missing target" };

        const relErr = checkStringField(e.relation, 1000, "edge.relation");
        if (relErr) return { valid: false, reason: relErr };

        const ctxErr = checkStringField(e.context, 1000, "edge.context");
        if (ctxErr) return { valid: false, reason: ctxErr };

        // Scan text fields for prompt injection
        const textFields = [e.relation, e.context].filter(Boolean).map(String);
        for (const text of textFields) {
            if (scanForPromptInjection(text)) {
                flagged.push(`edge:${e.source}->${e.target}`);
            }
        }
    }

    if (flagged.length > 0) {
        return { valid: false, reason: "prompt_injection_suspect", flaggedEntries: flagged };
    }

    return { valid: true };
}

/**
 * Validate nodes/edges submitted by the chat agent during enrichment.
 * Same checks as validateGraphBundle but on individual arrays.
 */
export function validateGraphEntries(
    nodes: Array<{ id: string; [k: string]: unknown }>,
    edges: Array<{ source: string; target: string; relation: string; [k: string]: unknown }>,
): ValidationResult {
    return validateGraphBundle({ nodes, edges });
}

// ── Embedding bundle validation ───────────────────────────────────────────────

const JAVA_CLASS_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/;

interface EmbeddingBundleHeader {
    version: number;
    model: string;
    dimensions: number;
    targetType?: "mod" | "vanilla" | "modloader";
    targetId?: string;
    targetVersion?: string;
    modId?: string;
    modVersion?: string;
    entries: Array<{ className: string; embedding: number[] }>;
}

/**
 * Validate an embedding bundle for security issues.
 */
export function validateEmbeddingBundle(bundle: unknown): ValidationResult {
    if (!bundle || typeof bundle !== "object") {
        return { valid: false, reason: "bundle must be an object" };
    }

    const b = bundle as Record<string, unknown>;

    // Reject proto pollution
    if (Object.prototype.hasOwnProperty.call(b, "__proto__") ||
        Object.prototype.hasOwnProperty.call(b, "constructor") ||
        Object.prototype.hasOwnProperty.call(b, "prototype")) {
        return { valid: false, reason: "proto_pollution" };
    }

    if (b.version !== 1) return { valid: false, reason: "unsupported bundle version" };
    if (typeof b.model !== "string" || b.model.length > 200) return { valid: false, reason: "invalid model field" };
    if (typeof b.dimensions !== "number" || b.dimensions < 1 || b.dimensions > 4096) {
        return { valid: false, reason: "dimensions out of range (1-4096)" };
    }
    const targetType = typeof b.targetType === "string" ? b.targetType : "mod";
    if (!["mod", "vanilla", "modloader"].includes(targetType)) {
        return { valid: false, reason: "invalid targetType" };
    }

    const targetId = typeof b.targetId === "string"
        ? b.targetId
        : typeof b.modId === "string"
            ? b.modId
            : null;
    const targetVersion = typeof b.targetVersion === "string"
        ? b.targetVersion
        : typeof b.modVersion === "string"
            ? b.modVersion
            : null;
    if (!targetId || targetId.length > 200) return { valid: false, reason: "invalid targetId" };
    if (!targetVersion || targetVersion.length > 200) return { valid: false, reason: "invalid targetVersion" };

    const entries = b.entries;
    if (!Array.isArray(entries)) return { valid: false, reason: "entries must be an array" };
    if (entries.length > 100_000) return { valid: false, reason: "too many entries (>100k)" };

    const dims = b.dimensions as number;

    for (const entry of entries) {
        if (!entry || typeof entry !== "object") return { valid: false, reason: "entry must be an object" };
        const e = entry as Record<string, unknown>;
        if ("__proto__" in e) return { valid: false, reason: "proto_pollution in entry" };

        // className validation
        if (typeof e.className !== "string") return { valid: false, reason: "entry missing className" };
        if (e.className.length > 500) return { valid: false, reason: "className too long" };
        if (!JAVA_CLASS_PATTERN.test(e.className)) {
            return { valid: false, reason: `invalid className format: ${e.className.slice(0, 50)}` };
        }

        // Embedding validation
        if (!Array.isArray(e.embedding)) return { valid: false, reason: "entry missing embedding array" };
        if (e.embedding.length !== dims) {
            return { valid: false, reason: `embedding dimension mismatch: expected ${dims}, got ${e.embedding.length}` };
        }

        for (const val of e.embedding as unknown[]) {
            if (typeof val !== "number" || !Number.isFinite(val)) {
                return { valid: false, reason: "embedding contains non-finite value" };
            }
            if (Math.abs(val) > 100) {
                return { valid: false, reason: "embedding value out of range (|x| > 100)" };
            }
        }
    }

    return { valid: true };
}
