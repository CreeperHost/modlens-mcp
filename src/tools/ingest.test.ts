import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (must be declared before SUT import) ─────────────────────
vi.mock("../repositories/mod.js", () => ({
    findModByJarPath: vi.fn(),
    findModByDupKey:  vi.fn(),
    findModBySha512:  vi.fn(),
    createMod:        vi.fn(),
    updateMod:        vi.fn(),
    findModById:      vi.fn(),
    listAllMods:      vi.fn(),
    countModClasses:  vi.fn(),
    createModClasses: vi.fn(),
}));

vi.mock("../processor.js", () => ({
    parseJar:      vi.fn(),
    computeHashes: vi.fn(),
}));

vi.mock("../modrinth.js", () => ({
    lookupBySha512: vi.fn(),
    getProject:     vi.fn(),
}));

vi.mock("../curseforge.js", () => ({
    lookupByFingerprint: vi.fn(),
}));

vi.mock("../java-tools.js", () => ({
    decompileJar:    vi.fn(),
    isDecompileDone: vi.fn(),
    indexJar:        vi.fn().mockResolvedValue({ classes: {} }),
}));

vi.mock("../cache.js", () => ({
    paths:     { decompiled: "/tmp/decompiled", source: "/tmp/source", jars: "/tmp/jars" },
    ensureDir: vi.fn(),
}));

vi.mock("fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("fs/promises")>();
    return { ...actual, readdir: vi.fn().mockResolvedValue([]) };
});

// ── Import SUT after mocks ─────────────────────────────────────────────────
const { ingestMod, reindexClasses, batchIngest } = await import("./ingest.js");
const fsPromises = await import("fs/promises");
const repo = await import("../repositories/mod.js");
const proc = await import("../processor.js");
const mr   = await import("../modrinth.js");
const cf   = await import("../curseforge.js");
const jt   = await import("../java-tools.js");

// ── Fixture data ───────────────────────────────────────────────────────────
const FAKE_MANIFEST = {
    modId: "testmod", displayName: "Test Mod", version: "1.0.0",
    mcVersion: "1.21.1", loader: "fabric", description: "",
    sourceUrl: null, dependencies: [], mixinConfigs: [],
    hasMixins: false, hasAt: false, hasAw: false,
    atEntries: [], awEntries: [], mixinTargets: [],
};

const FAKE_HASHES = { sha256: "aaa", sha512: "bbb", murmur2: "12345" };

const FAKE_DB_MOD = {
    id: 1, jarPath: "/mods/testmod.jar", modId: "testmod",
    displayName: "Test Mod", version: "1.0.0", mcVersion: "1.21.1",
    loader: "fabric", description: "", metadata: {},
    sha256: "aaa", sha512: "bbb", murmur2: "12345",
    hasMixins: false, hasAt: false, hasAw: false,
    mixinConfigs: [], mixinTargets: [], atEntries: [], awEntries: [],
    dependencies: [], createdAt: new Date(),
};

// ── Default mock setup (happy path) ───────────────────────────────────────
beforeEach(() => {
    vi.resetAllMocks();

    vi.mocked(repo.findModByJarPath).mockResolvedValue(null);
    vi.mocked(repo.findModByDupKey).mockResolvedValue(null);
    vi.mocked(repo.findModBySha512).mockResolvedValue(null);
    vi.mocked(repo.createMod).mockResolvedValue(FAKE_DB_MOD as any);
    vi.mocked(repo.updateMod).mockResolvedValue(FAKE_DB_MOD as any);
    vi.mocked(repo.findModById).mockResolvedValue(FAKE_DB_MOD as any);
    vi.mocked(repo.countModClasses).mockResolvedValue(0);
    vi.mocked(repo.createModClasses).mockResolvedValue(undefined as any);

    vi.mocked(proc.parseJar).mockResolvedValue(FAKE_MANIFEST as any);
    vi.mocked(proc.computeHashes).mockResolvedValue(FAKE_HASHES);

    vi.mocked(mr.lookupBySha512).mockResolvedValue(null);
    vi.mocked(mr.getProject).mockResolvedValue(null);
    vi.mocked(cf.lookupByFingerprint).mockResolvedValue(null);
    vi.mocked(jt.indexJar).mockResolvedValue({ classes: {} } as any);
});

// ── already_ingested ───────────────────────────────────────────────────────

describe("ingestMod — already_ingested", () => {
    it("returns already_ingested when JAR path already exists in DB", async () => {
        vi.mocked(repo.findModByJarPath).mockResolvedValue(FAKE_DB_MOD as any);

        const result = await ingestMod("/mods/testmod.jar");

        expect(result.status).toBe("already_ingested");
        expect(proc.parseJar).not.toHaveBeenCalled();
        expect(repo.createMod).not.toHaveBeenCalled();
    });
});

// ── duplicate_version ──────────────────────────────────────────────────────

describe("ingestMod — duplicate_version", () => {
    it("returns duplicate_version when same modId+version+loader exists at different path", async () => {
        const existingMod = { ...FAKE_DB_MOD, id: 99, jarPath: "/other/path/testmod.jar" };
        vi.mocked(repo.findModByDupKey).mockResolvedValue(existingMod as any);

        const result = await ingestMod("/mods/testmod-copy.jar");

        expect(result.status).toBe("duplicate_version");
        if (result.status !== "duplicate_version") throw new Error("unreachable");
        expect(result.existingJarPath).toBe("/other/path/testmod.jar");
        expect(result.existingDbId).toBe(99);
        expect(result.message).toContain("testmod");
        expect(repo.createMod).not.toHaveBeenCalled();
    });
});

// ── duplicate_hash ─────────────────────────────────────────────────────────

describe("ingestMod — duplicate_hash", () => {
    it("returns duplicate_hash when SHA-512 matches existing mod", async () => {
        const existingMod = { ...FAKE_DB_MOD, id: 42, jarPath: "/original/testmod.jar" };
        vi.mocked(repo.findModBySha512).mockResolvedValue(existingMod as any);

        const result = await ingestMod("/mods/testmod-renamed.jar");

        expect(result.status).toBe("duplicate_hash");
        if (result.status !== "duplicate_hash") throw new Error("unreachable");
        expect(result.existingDbId).toBe(42);
        expect(result.existingJarPath).toBe("/original/testmod.jar");
        expect(repo.createMod).not.toHaveBeenCalled();
    });
});

// ── ingested (happy path) ─────────────────────────────────────────────────

describe("ingestMod — ingested (happy path)", () => {
    it("creates mod record and returns ingested status", async () => {
        const result = await ingestMod("/mods/testmod.jar");

        expect(result.status).toBe("ingested");
        expect(repo.createMod).toHaveBeenCalledOnce();
        expect(repo.findModById).toHaveBeenCalled();
        if (result.status !== "ingested") throw new Error("unreachable");
        expect(result.mod).toEqual(FAKE_DB_MOD);
    });

    it("calls parseJar and computeHashes on the provided path", async () => {
        await ingestMod("/mods/testmod.jar");
        expect(proc.parseJar).toHaveBeenCalledWith("/mods/testmod.jar");
        expect(proc.computeHashes).toHaveBeenCalledWith("/mods/testmod.jar");
    });
});

// ── platform lookups ───────────────────────────────────────────────────────

describe("ingestMod — platform lookups", () => {
    it("calls updateMod with modrinthId when Modrinth returns a match", async () => {
        vi.mocked(mr.lookupBySha512).mockResolvedValue({
            project_id: "mr-abc-123",
        } as any);
        vi.mocked(mr.getProject).mockResolvedValue({
            id: "mr-abc-123",
            slug: "test-mod",
            source_url: "https://github.com/example/testmod",
        } as any);

        await ingestMod("/mods/testmod.jar");

        expect(repo.updateMod).toHaveBeenCalledWith(
            FAKE_DB_MOD.id,
            expect.objectContaining({ modrinthId: "mr-abc-123" }),
        );
    });

    it("calls updateMod with curseforgeId when CurseForge returns a match", async () => {
        vi.mocked(cf.lookupByFingerprint).mockResolvedValue({
            id: 99999,
            slug: "testmod",
            links: { sourceUrl: "https://github.com/example/testmod" },
        } as any);

        await ingestMod("/mods/testmod.jar");

        expect(repo.updateMod).toHaveBeenCalledWith(
            FAKE_DB_MOD.id,
            expect.objectContaining({ curseforgeId: 99999 }),
        );
    });

    it("skipSource=true skips all platform lookups", async () => {
        await ingestMod("/mods/testmod.jar", /* skipSource= */ true);

        expect(mr.lookupBySha512).not.toHaveBeenCalled();
        expect(cf.lookupByFingerprint).not.toHaveBeenCalled();
    });

    it("continues ingesting even if both platform lookups fail", async () => {
        vi.mocked(mr.lookupBySha512).mockRejectedValue(new Error("Modrinth down"));
        vi.mocked(cf.lookupByFingerprint).mockRejectedValue(new Error("CurseForge down"));

        const result = await ingestMod("/mods/testmod.jar");

        expect(result.status).toBe("ingested");
        expect(repo.createMod).toHaveBeenCalledOnce();
    });
});

// ── reindexClasses — single mod ───────────────────────────────────────────────

describe("reindexClasses — single mod", () => {
    it("indexes classes when mod has none yet", async () => {
        vi.mocked(jt.indexJar).mockResolvedValue({
            classes: {
                "com/example/A": { name: "com/example/A", superName: "java/lang/Object", interfaces: [], accessFlags: 1 },
            },
        } as any);

        const result = await reindexClasses(FAKE_DB_MOD.id);

        expect(result.indexed).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(0);
        expect(repo.createModClasses).toHaveBeenCalledOnce();
    });

    it("skips a mod that already has classes indexed", async () => {
        vi.mocked(repo.countModClasses).mockResolvedValue(42);

        const result = await reindexClasses(FAKE_DB_MOD.id);

        expect(result.skipped).toBe(1);
        expect(result.indexed).toBe(0);
        expect(jt.indexJar).not.toHaveBeenCalled();
        expect(repo.createModClasses).not.toHaveBeenCalled();
    });

    it("returns failed=1 when indexJar throws", async () => {
        vi.mocked(jt.indexJar).mockRejectedValue(new Error("JAR not found"));

        const result = await reindexClasses(FAKE_DB_MOD.id);

        expect(result.failed).toBe(1);
        expect(result.indexed).toBe(0);
        expect(repo.createModClasses).not.toHaveBeenCalled();
    });

    it("returns skipped=1 when indexJar returns no classes", async () => {
        vi.mocked(jt.indexJar).mockResolvedValue({ classes: {} } as any);

        const result = await reindexClasses(FAKE_DB_MOD.id);

        expect(result.skipped).toBe(1);
        expect(repo.createModClasses).not.toHaveBeenCalled();
    });
});

// ── reindexClasses — all mods ─────────────────────────────────────────────────

describe("reindexClasses — all mods (no dbId)", () => {
    it("processes all mods returned by listAllMods", async () => {
        const mod2 = { ...FAKE_DB_MOD, id: 2, jarPath: "/mods/other.jar" };
        vi.mocked(repo.listAllMods).mockResolvedValue([FAKE_DB_MOD, mod2] as any);
        vi.mocked(jt.indexJar).mockResolvedValue({
            classes: {
                "com/example/A": { name: "com/example/A", superName: "java/lang/Object", interfaces: [], accessFlags: 1 },
            },
        } as any);

        const result = await reindexClasses();

        expect(result.indexed).toBe(2);
        expect(repo.createModClasses).toHaveBeenCalledTimes(2);
    });
});

// ── batchIngest — empty directory ─────────────────────────────────────────────

describe("batchIngest — empty directory", () => {
    it("returns zero totals when directory has no JARs", async () => {
        vi.mocked(fsPromises.readdir).mockResolvedValue([] as any);

        const result = await batchIngest("/mods") as any;

        expect(result.total).toBe(0);
        expect(result.ingested).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.skipped).toBe(0);
    });
});

// ── batchIngest — with JARs ───────────────────────────────────────────────────

describe("batchIngest — with JARs", () => {
    beforeEach(() => {
        vi.mocked(fsPromises.readdir).mockResolvedValue(["alpha.jar", "beta.jar", "readme.txt"] as any);
    });

    it("processes only .jar files, ignores others", async () => {
        const result = await batchIngest("/mods", true) as any;
        expect(result.total).toBe(2);
    });

    it("counts ingested status correctly when all JARs are new", async () => {
        const result = await batchIngest("/mods", true) as any;
        expect(result.ingested).toBe(2);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(0);
    });

    it("counts skipped when ingestMod returns already_ingested", async () => {
        vi.mocked(repo.findModByJarPath).mockResolvedValue(FAKE_DB_MOD as any);

        const result = await batchIngest("/mods", true) as any;
        expect(result.skipped).toBe(2);
        expect(result.ingested).toBe(0);
    });

    it("counts failed when ingestMod throws", async () => {
        vi.mocked(proc.parseJar).mockRejectedValue(new Error("Corrupt JAR"));

        const result = await batchIngest("/mods", true) as any;
        expect(result.failed).toBe(2);
        expect(result.ingested).toBe(0);
        expect((result.results as any[]).every((r: any) => r.status.startsWith("error:"))).toBe(true);
    });

    it("includes modId and version in results for ingested JARs", async () => {
        const result = await batchIngest("/mods", true) as any;
        for (const r of result.results as any[]) {
            if (r.status === "ingested") {
                expect(r.modId).toBe(FAKE_DB_MOD.modId);
                expect(r.version).toBe(FAKE_DB_MOD.version);
            }
        }
    });
});

