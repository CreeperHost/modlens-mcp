import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { isDecompileDone, decompileSentinelDone, decompileSentinelRunning } from "./java-tools.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "modlens-decompile-state-")); });
afterEach(async () => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
    await rm(root, { recursive: true, force: true });
});
it("does not mistake a cached single class for a running bulk decompile", async () => {
    await writeFile(join(root, "Fixture.java"), "class Fixture {}");
    expect(await isDecompileDone(root)).toBe("not_started");
});
it("recognizes running, completed and abandoned jobs", async () => {
    await writeFile(decompileSentinelRunning(root), String(process.pid));
    expect(await isDecompileDone(root)).toBe("running");
    await writeFile(decompileSentinelRunning(root), "2147483647");
    expect(await isDecompileDone(root)).toBe("error");
    await writeFile(decompileSentinelDone(root), "0");
    expect(await isDecompileDone(root)).toBe("done");
});
