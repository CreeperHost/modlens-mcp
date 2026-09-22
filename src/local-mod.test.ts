import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = await mkdtemp(join(tmpdir(), "modlens-local-license-"));
vi.mock("./cache.js", async () => ({ CACHE_ROOT: root }));
const { executeLocalMod } = await import("./local-mod.js");
const jar = join(root, "fixture.jar");
const bytes = Buffer.from("synthetic JAR bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
afterEach(() => vi.clearAllMocks());
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
it("requires artifact-specific consent and validates the hash before invoking tools", async () => {
    await writeFile(jar, bytes);
    const decompile = vi.fn(async () => "one\ntwo\nthree");
    const request = { localJarPath: jar, sha256, className: "example.Fixture", startLine: 2, maxLines: 1 };
    await expect(executeLocalMod(request, decompile)).rejects.toThrow("acceptance");
    await expect(executeLocalMod({ ...request, sha256: "f".repeat(64), acceptedLocalDecompilation: true }, decompile)).rejects.toThrow("hash differs");
    expect(decompile).not.toHaveBeenCalled();
    expect(await executeLocalMod({ ...request, acceptedLocalDecompilation: true }, decompile)).toMatchObject({ executed: true, execution: "local", source: "two" });
    const copy = decompile.mock.calls[0]?.[0];
    expect(copy).not.toBe(jar);
    expect(await readFile(copy!)).toEqual(bytes);
});
it("rejects traversal and command-shaped class names", async () => {
    const decompile = vi.fn();
    for (const name of ["../Secret", "/Absolute", "a;command", "a:b", "a//b"]) {
        await expect(executeLocalMod({ localJarPath: jar, sha256, className: name, acceptedLocalDecompilation: true }, decompile)).rejects.toThrow();
    }
    expect(decompile).not.toHaveBeenCalled();
});
