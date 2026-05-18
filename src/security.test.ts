import { describe, it, expect } from "vitest";
import { validatePath, safeRegex, fileSha512, verifyFileHash, HashMismatchError, normalizeJarPath } from "./security.js";
import { tmpdir } from "os";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

// ── validatePath ──────────────────────────────────────────────────────────────

describe("validatePath", () => {
    const base = tmpdir();

    it("accepts a normal relative path inside base", () => {
        const result = validatePath("foo/bar.java", base);
        expect(result).toContain("foo");
        expect(result).toContain("bar.java");
    });

    it("throws on simple path traversal (../)", () => {
        expect(() => validatePath("../etc/passwd", base)).toThrow("Path traversal");
    });

    it("throws on deep traversal attempt", () => {
        expect(() => validatePath("foo/../../etc/passwd", base)).toThrow("Path traversal");
    });

    it("accepts a plain filename with no subdirectory", () => {
        expect(() => validatePath("World.java", base)).not.toThrow();
    });

    it("throws on absolute path that escapes base", () => {
        expect(() => validatePath("/etc/passwd", base)).toThrow("Path traversal");
    });
});

// ── safeRegex ─────────────────────────────────────────────────────────────────

describe("safeRegex", () => {
    it("compiles a valid regex", () => {
        const r = safeRegex("foo.*bar");
        expect(r.test("fooXXXbar")).toBe(true);
    });

    it("throws on invalid regex syntax", () => {
        expect(() => safeRegex("(unclosed")).toThrow("Invalid regex");
    });

    it("throws when pattern exceeds max length", () => {
        const long = "a".repeat(501);
        expect(() => safeRegex(long)).toThrow("too long");
    });

    it("accepts pattern exactly at max length", () => {
        const ok = "a".repeat(500);
        expect(() => safeRegex(ok)).not.toThrow();
    });

    it("applies flags correctly", () => {
        const r = safeRegex("foo", "gi");
        expect(r.flags).toContain("g");
        expect(r.flags).toContain("i");
    });
});

// ── fileSha512 ────────────────────────────────────────────────────────────────

describe("fileSha512", () => {
    it("returns hex SHA-512 of a known buffer", async () => {
        const content = Buffer.from("hello world", "utf8");
        const expected = createHash("sha512").update(content).digest("hex");
        const tmpFile = join(tmpdir(), `security-test-${Date.now()}.bin`);
        await writeFile(tmpFile, content);
        try {
            expect(await fileSha512(tmpFile)).toBe(expected);
        } finally {
            await unlink(tmpFile).catch(() => {});
        }
    });
});

// ── verifyFileHash ────────────────────────────────────────────────────────────

describe("verifyFileHash", () => {
    it("resolves without error when hash matches", async () => {
        const content = Buffer.from("test data", "utf8");
        const expected = createHash("sha512").update(content).digest("hex");
        const tmpFile = join(tmpdir(), `security-test-${Date.now()}.bin`);
        await writeFile(tmpFile, content);
        try {
            await expect(verifyFileHash(tmpFile, expected)).resolves.toBeUndefined();
        } finally {
            await unlink(tmpFile).catch(() => {});
        }
    });

    it("throws HashMismatchError when hash does not match", async () => {
        const content = Buffer.from("real data", "utf8");
        const tmpFile = join(tmpdir(), `security-test-${Date.now()}.bin`);
        await writeFile(tmpFile, content);
        try {
            const wrong = "a".repeat(128);
            await expect(verifyFileHash(tmpFile, wrong)).rejects.toBeInstanceOf(HashMismatchError);
        } finally {
            await unlink(tmpFile).catch(() => {});
        }
    });

    it("HashMismatchError carries expected and actual in message", async () => {
        const content = Buffer.from("data", "utf8");
        const tmpFile = join(tmpdir(), `security-test-${Date.now()}.bin`);
        await writeFile(tmpFile, content);
        try {
            await expect(verifyFileHash(tmpFile, "0".repeat(128))).rejects.toSatisfy((e: unknown) => {
                return e instanceof HashMismatchError &&
                    (e as Error).message.includes("expected") &&
                    (e as Error).message.includes("actual");
            });
        } finally {
            await unlink(tmpFile).catch(() => {});
        }
    });
});

// ── normalizeJarPath ──────────────────────────────────────────────────────────

describe("normalizeJarPath", () => {
    const isWin = process.platform === "win32";

    it("converts /mnt/c/ WSL path to C:\\ on Windows", () => {
        const result = normalizeJarPath("/mnt/c/mods/create.jar");
        if (isWin) expect(result).toBe("C:\\mods\\create.jar");
        else expect(result).toBe("/mnt/c/mods/create.jar");
    });

    it("handles uppercase drive letter", () => {
        const result = normalizeJarPath("/mnt/D/mods/sodium.jar");
        if (isWin) expect(result).toBe("D:\\mods\\sodium.jar");
        else expect(result).toBe("/mnt/D/mods/sodium.jar");
    });

    it("leaves native Windows paths unchanged", () => {
        const result = normalizeJarPath("C:\\mods\\fabric.jar");
        expect(result).toBe("C:\\mods\\fabric.jar");
    });

    it("leaves native Unix paths unchanged", () => {
        const result = normalizeJarPath("/home/user/mods/forge.jar");
        if (isWin) expect(result).toBe("/home/user/mods/forge.jar"); // no /mnt/ prefix — unchanged
        else expect(result).toBe("/home/user/mods/forge.jar");
    });

    it("handles /mnt/c root (no trailing path)", () => {
        const result = normalizeJarPath("/mnt/c");
        if (isWin) expect(result).toBe("C:\\");
        else expect(result).toBe("/mnt/c");
    });
});
