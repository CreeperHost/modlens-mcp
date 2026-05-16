import { resolve, relative, isAbsolute } from "path";
import { createHash } from "crypto";
import { readFile } from "fs/promises";

// ── Path traversal guard ──────────────────────────────────────────────────────

/**
 * Validate that `untrusted` resolves to a path inside `base`.
 * Throws if it would escape (path traversal attempt).
 * Returns the resolved absolute path on success.
 */
export function validatePath(untrusted: string, base: string): string {
    const resolvedBase = resolve(base);
    const resolvedTarget = resolve(base, untrusted);

    // Absolute paths that don't start with resolvedBase are traversals
    if (isAbsolute(untrusted) && !resolvedTarget.startsWith(resolvedBase + "/") && resolvedTarget !== resolvedBase) {
        throw new Error(`Path traversal attempt rejected: '${untrusted}'`);
    }

    const rel = relative(resolvedBase, resolvedTarget);
    if (rel.startsWith("..")) {
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
