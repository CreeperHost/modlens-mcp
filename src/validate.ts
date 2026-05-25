/**
 * Lightweight semantic validators for MCP tool inputs.
 * Throw descriptive errors on invalid input.
 */

const VERSION_MAX_LEN = 64;
const CLASS_MAX_LEN = 200;
const SHELL_META = /[;&|`<>\\'"*?{}[\]!#~]/;
/** Class names may contain $ (inner classes) but must not have shell-dangerous chars. */
const CLASS_ILLEGAL = /[;&|`<>\\'"*?{}[\]!#~]/;

/**
 * Validate a database record ID: must be a positive integer.
 */
export function validateDbId(id: number): number {
    if (!Number.isInteger(id) || id < 1) {
        throw new Error(`Invalid dbId: expected a positive integer, got ${id}`);
    }
    return id;
}

/**
 * Validate a Minecraft version string.
 * Must be non-empty, ≤64 chars, no shell metacharacters.
 */
export function validateVersion(version: string): string {
    if (!version || version.length === 0) {
        throw new Error(`Invalid version: must not be empty`);
    }
    if (version.length > VERSION_MAX_LEN) {
        throw new Error(`Invalid version: too long (max ${VERSION_MAX_LEN} chars)`);
    }
    if (SHELL_META.test(version)) {
        throw new Error(`Invalid version: contains illegal characters`);
    }
    return version;
}

/**
 * Validate a Java class name (slash- or dot-separated binary format).
 * Must be non-empty, ≤200 chars, no path traversal, no shell metacharacters.
 */
export function validateClassName(className: string): string {
    if (!className || className.length === 0) {
        throw new Error(`Invalid className: must not be empty`);
    }
    if (className.length > CLASS_MAX_LEN) {
        throw new Error(`Invalid className: too long (max ${CLASS_MAX_LEN} chars)`);
    }
    if (className.includes("..")) {
        throw new Error(`Invalid className: path traversal sequence detected`);
    }
    if (CLASS_ILLEGAL.test(className)) {
        throw new Error(`Invalid className: contains illegal characters`);
    }
    return className;
}
