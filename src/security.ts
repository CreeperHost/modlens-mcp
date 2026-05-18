import { resolve, relative, isAbsolute, sep } from "path";
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

    // Absolute paths that don't start with resolvedBase are traversals
    const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
    if (isAbsolute(untrusted) && !resolvedTarget.startsWith(baseWithSep) && resolvedTarget !== resolvedBase) {
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
