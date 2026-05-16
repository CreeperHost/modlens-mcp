import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkModCompat } from "./compat-check.js";

vi.mock("../processor.js", () => ({ parseJar: vi.fn() }));
vi.mock("../jar.js", () => ({ listEntries: vi.fn(), extractEntry: vi.fn() }));
vi.mock("../repositories/mod.js", () => ({
    listModsSlim: vi.fn(),
}));
vi.mock("../security.js", () => ({ validatePath: vi.fn() }));
vi.mock("../db.js", () => ({
    getDb: vi.fn().mockResolvedValue({
        $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    }),
}));

import { parseJar } from "../processor.js";
import { listEntries, extractEntry } from "../jar.js";
import { listModsSlim } from "../repositories/mod.js";
import { getDb } from "../db.js";

const BASE_MANIFEST = {
    modId: "newmod", displayName: "New Mod", version: "1.0",
    mcVersion: "1.21", loader: "neoforge" as const,
    dependencies: [], mixinConfigs: [], hasMixins: false,
    hasAt: false, hasAw: false,
    atEntries: [], awEntries: [], mixinTargets: [],
    description: "", sourceUrl: null,
};

const EXISTING_MOD = {
    id: 1, modId: "existingmod", displayName: "Existing Mod", version: "2.0",
    jarPath: "/existing.jar", loader: "neoforge", mcVersion: "1.21",
};

beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listModsSlim).mockResolvedValue([]);
    vi.mocked(listEntries).mockReturnValue([]);
    vi.mocked(extractEntry).mockReturnValue(null);
    vi.mocked(getDb).mockResolvedValue({ $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as any);
});

describe("checkModCompat", () => {
    it("returns no issues for a clean candidate", async () => {
        vi.mocked(parseJar).mockResolvedValue({ ...BASE_MANIFEST });

        const result = await checkModCompat("/clean.jar") as any;

        expect(result.issues).toHaveLength(0);
        expect(result.summary.safe).toBe(true);
        expect(result.summary.errors).toBe(0);
    });

    it("returns candidate metadata in output", async () => {
        vi.mocked(parseJar).mockResolvedValue({ ...BASE_MANIFEST });

        const result = await checkModCompat("/test.jar", "1.21", "neoforge") as any;

        expect(result.candidate.modId).toBe("newmod");
        expect(result.candidate.version).toBe("1.0");
        expect(result.candidate.loader).toBe("neoforge");
        expect(result.candidate.mcVersion).toBe("1.21");
    });

    it("reports mixin conflict as error", async () => {
        vi.mocked(parseJar).mockResolvedValue({
            ...BASE_MANIFEST,
            hasMixins: true,
            mixinTargets: ["net/minecraft/world/level/Level"],
        });
        vi.mocked(getDb).mockResolvedValue({ $queryRawUnsafe: vi.fn().mockResolvedValue([
            { mod_id: "existingmod", display_name: "Existing Mod", matched: ["net/minecraft/world/level/Level"] },
        ]) } as any);

        const result = await checkModCompat("/new.jar") as any;

        const mixinIssues = result.issues.filter((i: any) => i.type === "mixin_conflict");
        expect(mixinIssues).toHaveLength(1);
        expect(mixinIssues[0].severity).toBe("error");
        expect(mixinIssues[0].relatedMod).toBe("existingmod");
        expect(mixinIssues[0].path).toBe("net/minecraft/world/level/Level");
        expect(result.summary.safe).toBe(false);
    });

    it("reports multiple mixin conflicts across different mods", async () => {
        vi.mocked(parseJar).mockResolvedValue({
            ...BASE_MANIFEST,
            hasMixins: true,
            mixinTargets: ["net/minecraft/world/level/Level", "net/minecraft/server/level/ServerLevel"],
        });
        vi.mocked(getDb).mockResolvedValue({ $queryRawUnsafe: vi.fn().mockResolvedValue([
            { mod_id: "mod_a", display_name: "Mod A", matched: ["net/minecraft/world/level/Level"] },
            { mod_id: "mod_b", display_name: "Mod B", matched: ["net/minecraft/server/level/ServerLevel"] },
        ]) } as any);

        const result = await checkModCompat("/new.jar") as any;

        expect(result.summary.errors).toBe(2);
        expect(result.issues.filter((i: any) => i.type === "mixin_conflict")).toHaveLength(2);
    });

    it("skips mixin check when candidate has no mixin targets", async () => {
        vi.mocked(parseJar).mockResolvedValue({ ...BASE_MANIFEST, mixinTargets: [] });

        await checkModCompat("/new.jar");

        const result = await checkModCompat("/new.jar") as any;
        expect(result.issues.filter((i: any) => i.type === "mixin_conflict")).toHaveLength(0);
    });

    it("reports asset conflict as warn", async () => {
        vi.mocked(parseJar).mockResolvedValue({ ...BASE_MANIFEST });
        vi.mocked(listModsSlim).mockResolvedValue([EXISTING_MOD] as any);

        // listEntries: first call (candidate assets), second call (existing mod assets)
        vi.mocked(listEntries)
            .mockReturnValueOnce(["assets/newmod/textures/item/thing.png"])   // candidate
            .mockReturnValueOnce(["assets/newmod/textures/item/thing.png"]);  // existing mod

        const result = await checkModCompat("/new.jar") as any;

        const assetIssues = result.issues.filter((i: any) => i.type === "asset_conflict");
        expect(assetIssues).toHaveLength(1);
        expect(assetIssues[0].severity).toBe("warn");
        expect(assetIssues[0].relatedMod).toBe("existingmod");
    });

    it("reports missing dep as warn", async () => {
        vi.mocked(parseJar).mockResolvedValue({
            ...BASE_MANIFEST,
            dependencies: [{ id: "missinglib", version: ">=1.0", required: true }],
        });
        vi.mocked(listModsSlim).mockResolvedValue([]);

        const result = await checkModCompat("/new.jar") as any;

        const depIssues = result.issues.filter((i: any) => i.type === "missing_dep");
        expect(depIssues).toHaveLength(1);
        expect(depIssues[0].severity).toBe("warn");
        expect(depIssues[0].detail).toContain("missinglib");
    });

    it("ignores loader-level pseudo-deps in missing dep check", async () => {
        vi.mocked(parseJar).mockResolvedValue({
            ...BASE_MANIFEST,
            dependencies: [
                { id: "minecraft",   version: "1.21", required: true },
                { id: "neoforge",    version: ">=21", required: true },
                { id: "java",        version: ">=21", required: true },
            ],
        });
        vi.mocked(listModsSlim).mockResolvedValue([]);

        const result = await checkModCompat("/new.jar") as any;

        expect(result.issues.filter((i: any) => i.type === "missing_dep")).toHaveLength(0);
    });

    it("does not report missing dep when dep is ingested", async () => {
        vi.mocked(parseJar).mockResolvedValue({
            ...BASE_MANIFEST,
            dependencies: [{ id: "presentlib", version: "1.0", required: true }],
        });
        vi.mocked(listModsSlim).mockResolvedValue([
            { id: 5, modId: "presentlib", displayName: "Present Lib", version: "1.0", jarPath: "/lib.jar", loader: "neoforge", mcVersion: "1.21" },
        ] as any);

        const result = await checkModCompat("/new.jar") as any;

        expect(result.issues.filter((i: any) => i.type === "missing_dep")).toHaveLength(0);
    });

    it("summary.safe is false when there are errors", async () => {
        vi.mocked(parseJar).mockResolvedValue({
            ...BASE_MANIFEST,
            hasMixins: true,
            mixinTargets: ["net/minecraft/world/level/Level"],
        });
        vi.mocked(getDb).mockResolvedValue({ $queryRawUnsafe: vi.fn().mockResolvedValue([
            { mod_id: "other", display_name: "Other", matched: ["net/minecraft/world/level/Level"] },
        ]) } as any);

        const result = await checkModCompat("/new.jar") as any;
        expect(result.summary.safe).toBe(false);
        expect(result.summary.errors).toBeGreaterThan(0);
    });

    it("summary.safe is true when only warnings", async () => {
        vi.mocked(parseJar).mockResolvedValue({
            ...BASE_MANIFEST,
            dependencies: [{ id: "missinglib", version: "*", required: false }],
        });
        vi.mocked(listModsSlim).mockResolvedValue([]);

        const result = await checkModCompat("/new.jar") as any;
        expect(result.summary.safe).toBe(true);
        expect(result.summary.warnings).toBeGreaterThan(0);
    });
});
