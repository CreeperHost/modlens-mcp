import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { ProjectStore, projectAction, PROJECT_CHUNK_BYTES } from "./project.js";

vi.mock("../java-tools.js", () => ({
    inspectClass: vi.fn(async (path: string) => ({ path, accessFlags: 1 })),
    getBytecode: vi.fn(async (path: string) => path),
    decompileClass: vi.fn(async () => "public class Missing {}"),
}));

const key = "1".repeat(64);
const otherKey = "2".repeat(64);
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function jar(files: Record<string, string>) {
    const zip = new AdmZip();
    for (const [name, text] of Object.entries(files)) zip.addFile(name, Buffer.from(text));
    return zip.toBuffer();
}
function bundle(text = "public int counter;", mutate?: (manifest: any, zip: AdmZip) => void, extra = false) {
    const binary = jar({ "example/Target.class": "class bytes", "example/Target.java": text });
    const second = jar({ "example/Target.class": "shadowed class", "example/Target.java": "WRONG SOURCE" });
    const artifacts = [{ path: "artifacts/0.jar", name: "prepared.jar", sha256: hash(binary), size: binary.length, kind: "classpath" }];
    const zip = new AdmZip();
    zip.addFile("artifacts/0.jar", binary);
    if (extra) {
        artifacts.push({ path: "artifacts/1.jar", name: "other.jar", sha256: hash(second), size: second.length, kind: "classpath" });
        zip.addFile("artifacts/1.jar", second);
    }
    const manifest = { format: "modlens-project-v1", project: "example:", sourceSet: "main", toolchain: "moddevgradle",
        minecraftVersion: "1.21.1", loaderVersion: "21.1", mappings: "official", javaVersion: 21,
        transformations: [{ name: "accesstransformer.cfg", sha256: hash(text) }], artifacts };
    mutate?.(manifest, zip);
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
    return zip.toBuffer();
}

describe("private project environments", () => {
    let root: string;
    let store: ProjectStore;
    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "modlens-project-test-")); store = new ProjectStore(root); });
    afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

    it("keeps project snapshots private and does not create shared MC/mod caches", async () => {
        const imported = await store.importBuffer(key, bundle());
        expect((await store.list(key)).length).toBe(1);
        expect(await store.list(otherKey)).toEqual([]);
        await expect(store.describe(otherKey, imported.environmentId)).rejects.toThrow("not found");
        expect(await readdir(root)).toEqual([hash(key)]);
        const inspected = await store.members(key, imported.environmentId, "example.Target");
        expect((inspected.result as any).path).toContain(join(hash(key), "environments", imported.environmentId, "artifacts", "0.jar"));
    });

    it("refreshes on changed ATs without overwriting the previous environment", async () => {
        const before = await store.importBuffer(key, bundle("private final int counter;"));
        const after = await store.importBuffer(key, bundle("public int counter;"));
        expect(after.environmentId).not.toBe(before.environmentId);
        expect((await store.source(key, before.environmentId, "example.Target")).source).toBe("private final int counter;");
        expect((await store.source(key, after.environmentId, "example.Target")).source).toBe("public int counter;");
        expect((await store.search(key, after.environmentId, "public int")).results).toHaveLength(1);
        expect((await store.search(key, after.environmentId, "private final")).results).toHaveLength(0);
    });

    it("uses first classpath entry and its matching sources", async () => {
        const imported = await store.importBuffer(key, bundle("RIGHT SOURCE", undefined, true));
        expect(imported.shadowedClasses).toBe(1);
        expect((await store.source(key, imported.environmentId, "example.Target")).source).toBe("RIGHT SOURCE");
        expect((await store.search(key, imported.environmentId, "WRONG")).results).toEqual([]);
    });

    it("pairs separate sources only with the winning binary", async () => {
        const data = bundle("first", (m, zip) => {
            const bytes = jar({ "example/Target.java": "separate source" });
            const binary = jar({ "example/Target.class": "prepared bytes" });
            zip.updateFile("artifacts/0.jar", binary);
            Object.assign(m.artifacts[0], { size: binary.length, sha256: hash(binary) });
            zip.addFile("artifacts/1.jar", bytes);
            m.artifacts.push({ path: "artifacts/1.jar", name: "sources.jar", size: bytes.length, sha256: hash(bytes), kind: "sources", sourceFor: "artifacts/0.jar" });
        });
        const imported = await store.importBuffer(key, data);
        expect((await store.source(key, imported.environmentId, "example.Target")).source).toBe("separate source");
    });

    it("deduplicates concurrent imports by content without mutating a snapshot", async () => {
        const data = bundle();
        const [a, b] = await Promise.all([store.importBuffer(key, data), store.importBuffer(key, data)]);
        expect(a.environmentId).toBe(b.environmentId);
        expect(await store.list(key)).toHaveLength(1);
    });

    it("selects multi-release classes for the compile Java version and excludes stale base sources", async () => {
        const data = bundle("x", (m, zip) => {
            const bytes = jar({ "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\r\nMulti-Release: true\r\n\r\n",
                "example/Target.class": "base", "example/Target.java": "STALE BASE SOURCE",
                "META-INF/versions/17/example/Target.class": "java17",
                "META-INF/versions/21/example/Target.class": "java21",
                "META-INF/versions/25/example/Target.class": "java25" });
            zip.updateFile("artifacts/0.jar", bytes);
            Object.assign(m.artifacts[0], { size: bytes.length, sha256: hash(bytes) });
        });
        const imported = await store.importBuffer(key, data);
        expect(imported.sourceCount).toBe(0);
        const inspected = await store.members(key, imported.environmentId, "example.Target");
        const path = (inspected.result as any).path;
        expect(path).toContain(join("effective", "0.jar"));
        const effective = new AdmZip(await readFile(path));
        expect(effective.readAsText("example/Target.class")).toBe("java21");
        expect(effective.getEntry("META-INF/versions/25/example/Target.class")).toBeNull();
        expect((await store.search(key, imported.environmentId, "STALE")).results).toEqual([]);
    });

    it("enforces the concurrent unfinished-upload quota", async () => {
        const uploads = await Promise.allSettled(Array.from({ length: 5 }, () => store.begin(key, 3, hash("abc"))));
        expect(uploads.filter(r => r.status === "fulfilled")).toHaveLength(4);
        expect(uploads.filter(r => r.status === "rejected")).toHaveLength(1);
    });

    it("accepts bounded upload chunks, retries and idempotent finish", async () => {
        const data = bundle();
        const upload = await store.begin(key, data.length, hash(data));
        const first = data.subarray(0, 100).toString("base64");
        expect(await store.chunk(key, upload.uploadId, 0, first)).toEqual({ offset: 100 });
        expect(await store.chunk(key, upload.uploadId, 0, first)).toEqual({ offset: 100 });
        await expect(store.finish(key, upload.uploadId)).rejects.toThrow("incomplete");
        await store.chunk(key, upload.uploadId, 100, data.subarray(100).toString("base64"));
        const result = await store.finish(key, upload.uploadId);
        expect(await store.finish(key, upload.uploadId)).toEqual(result);
        expect((await store.classes(key, result.environmentId)).classes[0].name).toBe("example/Target");
    });

    it("handles a full 1 MiB chunk without a regex stack overflow", async () => {
        const data = Buffer.alloc(PROJECT_CHUNK_BYTES, 42);
        const upload = await store.begin(key, data.length, hash(data));
        expect(await store.chunk(key, upload.uploadId, 0, data.toString("base64"))).toEqual({ offset: data.length });
    });

    it("rejects changed retries, gaps, oversized chunks and a wrong project key", async () => {
        const upload = await store.begin(key, 100, hash("unused"));
        await store.chunk(key, upload.uploadId, 0, Buffer.from("abc").toString("base64"));
        await expect(store.chunk(key, upload.uploadId, 0, Buffer.from("xyz").toString("base64"))).rejects.toThrow("does not match");
        await expect(store.chunk(key, upload.uploadId, 10, "YWJj")).rejects.toThrow("offset");
        await expect(store.chunk(key, upload.uploadId, 3, Buffer.alloc(PROJECT_CHUNK_BYTES + 1).toString("base64"))).rejects.toThrow();
        await expect(store.finish(otherKey, upload.uploadId)).rejects.toThrow();
        await store.abort(key, upload.uploadId);
        await expect(store.chunk(key, upload.uploadId, 0, "YWJj")).rejects.toThrow();
    });

    it("rejects upload checksum errors", async () => {
        const data = bundle();
        const upload = await store.begin(key, data.length, "a".repeat(64));
        await store.chunk(key, upload.uploadId, 0, data.toString("base64"));
        await expect(store.finish(key, upload.uploadId)).rejects.toThrow("checksum");
    });

    it("rejects corrupt artifacts without publishing a partial snapshot", async () => {
        await expect(store.importBuffer(key, bundle("x", m => { m.artifacts[0].sha256 = "0".repeat(64); }))).rejects.toThrow("checksum");
        expect(await store.list(key)).toEqual([]);
        expect(await readdir(join(root, hash(key), "staging"))).toEqual([]);
    });

    it("rejects archive traversal and undeclared files", async () => {
        const data = bundle("x", (_, zip) => zip.addFile("safe_/evil.txt", Buffer.from("bad")));
        // Replace both central/local filenames; ZIP libraries sanitize traversal in addFile.
        const unsafe = Buffer.from(data.toString("latin1").replaceAll("safe_/evil.txt", "../../evil.txt"), "latin1");
        await expect(store.importBuffer(key, unsafe)).rejects.toThrow("Unsafe");
        await expect(store.importBuffer(key, data)).rejects.toThrow("Undeclared");
        expect(await store.list(key)).toEqual([]);
    });

    it("rejects ambiguous artifact names and missing source linkage", async () => {
        await expect(store.importBuffer(key, bundle("x", m => m.artifacts.push(m.artifacts[0])))).rejects.toThrow("Duplicate");
        await expect(store.importBuffer(key, bundle("x", m => { m.artifacts[0].kind = "sources"; }))).rejects.toThrow("reference");
    });

    it("rejects path-like keys, IDs and class names", async () => {
        await expect(store.list("../../other")).rejects.toThrow("projectKey");
        await expect(store.snapshot(key, "../shared")).rejects.toThrow();
        const imported = await store.importBuffer(key, bundle());
        await expect(store.source(key, imported.environmentId, "../../secret")).rejects.toThrow("className");
    });

    it("validates required query parameters and bounds", async () => {
        await expect(projectAction({ action: "source", projectKey: key }, store)).rejects.toThrow("environmentId");
        await expect(projectAction({ action: "classes", projectKey: key, limit: -1 }, store)).rejects.toThrow();
        await expect(projectAction({ action: "search", projectKey: key, environmentId: "a".repeat(64), query: "" }, store)).rejects.toThrow("query");
    });

    it("imports host-local bundles but rejects host filesystem import in HTTP mode", async () => {
        const path = join(root, "bundle.zip");
        await writeFile(path, bundle());
        vi.stubEnv("MCP_PORT", "");
        expect((await store.importLocal(key, path)).classCount).toBe(1);
        vi.stubEnv("MCP_PORT", "9999");
        await expect(store.importLocal(key, path)).rejects.toThrow("disabled over HTTP");
    });
});
