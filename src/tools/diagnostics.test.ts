import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeCrashLog, findMissingDeps } from "./diagnostics.js";

vi.mock("../repositories/mod.js", () => ({
    findModClassesByClassNames: vi.fn(),
    listAllMods: vi.fn(),
}));

import { findModClassesByClassNames, listAllMods } from "../repositories/mod.js";

const SAMPLE_CRASH = `
---- Minecraft Crash Report ----
java.lang.NullPointerException: Cannot invoke method
\tat net.minecraft.world.level.Level.tickChunk(Level.java:345)
\tat com.example.mymod.MyWorldMixin.tickChunk(MyWorldMixin.java:12)
\tat net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:890)
\tat com.example.other.OtherMixin.runServer(OtherMixin.java:5)
\tat com.example.other.OtherMixin.extra(OtherMixin.java:30)

-- Mod List --
mymod|1.0
othermod|2.0
`;

describe("analyzeCrashLog", () => {
    beforeEach(() => vi.resetAllMocks());

    it("ranks mods by frame count and returns suspects", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([
            { className: "com/example/mymod/MyWorldMixin",  modId: 1, mod: { modId: "mymod",    displayName: "My Mod"    } },
            { className: "com/example/other/OtherMixin",    modId: 2, mod: { modId: "othermod", displayName: "Other Mod" } },
        ]);

        const result = await analyzeCrashLog(SAMPLE_CRASH) as any;

        expect(result.suspects).toHaveLength(2);
        // othermod appears in 2 frames — should rank first
        expect(result.suspects[0].modId).toBe("othermod");
        expect(result.suspects[0].frameCount).toBe(2);
        expect(result.suspects[1].modId).toBe("mymod");
        expect(result.suspects[1].frameCount).toBe(1);
    });

    it("reports unrecognized frames and emits coverageWarning", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
        const result = await analyzeCrashLog(SAMPLE_CRASH) as any;
        expect(result.unrecognizedFrames).toBeGreaterThan(0);
        expect(result.coverageWarning).toBeDefined();
        expect(result.coverageWarning).toContain("reindex_classes");
    });

    it("returns empty suspects for empty log", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
        const result = await analyzeCrashLog("") as any;
        expect(result.suspects).toHaveLength(0);
        expect(result.totalFrames).toBe(0);
    });

    it("parses -- Mod List -- section", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
        const result = await analyzeCrashLog(SAMPLE_CRASH) as any;
        expect(result.modsInLogSection).toContain("mymod");
        expect(result.modsInLogSection).toContain("othermod");
    });

    it("does not emit coverageWarning when all frames recognized", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([
            { className: "com/example/mymod/MyWorldMixin",  modId: 1, mod: { modId: "mymod",    displayName: "My Mod"    } },
            { className: "com/example/other/OtherMixin",    modId: 2, mod: { modId: "othermod", displayName: "Other Mod" } },
            { className: "net/minecraft/world/level/Level", modId: 3, mod: { modId: "mcmod",    displayName: "MC Mod"    } },
            { className: "net/minecraft/server/MinecraftServer", modId: 3, mod: { modId: "mcmod", displayName: "MC Mod" } },
        ]);
        const result = await analyzeCrashLog(SAMPLE_CRASH) as any;
        expect(result.coverageWarning).toBeUndefined();
    });

    it("caps suspects at 10", async () => {
        // Build a crash log with 15 different mods
        const lines = Array.from({ length: 15 }, (_, i) =>
            `\tat com.example.mod${i}.Mixin.method(Mixin.java:1)`
        ).join("\n");
        vi.mocked(findModClassesByClassNames).mockResolvedValue(
            Array.from({ length: 15 }, (_, i) => ({
                className: `com/example/mod${i}/Mixin`,
                modId: i + 1,
                mod: { modId: `mod${i}`, displayName: `Mod ${i}` },
            }))
        );
        const result = await analyzeCrashLog(lines) as any;
        expect(result.suspects.length).toBeLessThanOrEqual(10);
    });
});

describe("findMissingDeps", () => {
    beforeEach(() => vi.resetAllMocks());

    it("flags a mod dependency that is not ingested", async () => {
        vi.mocked(listAllMods).mockResolvedValue([
            {
                id: 1, modId: "mymod", displayName: "My Mod", version: "1.0",
                mcVersion: "1.21", loader: "neoforge", jarPath: "/a.jar",
                dependencies: [
                    { id: "requiredmod", version: ">=1.0", required: true },
                    { id: "minecraft",   version: "1.21",  required: true },
                ],
            },
        ] as any);

        const result = await findMissingDeps() as any;
        expect(result.unsatisfied).toBe(1);
        expect(result.missing[0].depModId).toBe("requiredmod");
        expect(result.missing[0].requiredBy).toBe("mymod");
        expect(result.missing[0].mandatory).toBe(true);
    });

    it("ignores loader-level pseudo-deps", async () => {
        vi.mocked(listAllMods).mockResolvedValue([
            {
                id: 1, modId: "mymod", displayName: "My Mod", version: "1.0",
                mcVersion: "1.21", loader: "neoforge", jarPath: "/a.jar",
                dependencies: [
                    { id: "minecraft",   version: "1.21", required: true },
                    { id: "neoforge",    version: ">=21", required: true },
                    { id: "java",        version: ">=21", required: true },
                    { id: "fabric-api",  version: "*",    required: false },
                    { id: "fabricloader",version: "*",    required: false },
                    { id: "quilt_loader",version: "*",    required: false },
                    { id: "forge",       version: "*",    required: false },
                ],
            },
        ] as any);

        const result = await findMissingDeps() as any;
        expect(result.unsatisfied).toBe(0);
        expect(result.missing).toHaveLength(0);
    });

    it("reports satisfied when dep is ingested", async () => {
        vi.mocked(listAllMods).mockResolvedValue([
            {
                id: 1, modId: "mymod", displayName: "My Mod", version: "1.0",
                mcVersion: "1.21", loader: "neoforge", jarPath: "/a.jar",
                dependencies: [{ id: "lib", version: "1.0", required: true }],
            },
            {
                id: 2, modId: "lib", displayName: "Lib", version: "1.0",
                mcVersion: "1.21", loader: "neoforge", jarPath: "/lib.jar",
                dependencies: [],
            },
        ] as any);

        const result = await findMissingDeps() as any;
        expect(result.satisfied).toBe(1);
        expect(result.unsatisfied).toBe(0);
    });

    it("filters pool by mcVersion", async () => {
        vi.mocked(listAllMods).mockResolvedValue([
            {
                id: 1, modId: "oldmod", displayName: "Old Mod", version: "1.0",
                mcVersion: "1.20", loader: "neoforge", jarPath: "/old.jar",
                dependencies: [{ id: "missingdep", version: "*", required: true }],
            },
            {
                id: 2, modId: "newmod", displayName: "New Mod", version: "1.0",
                mcVersion: "1.21", loader: "neoforge", jarPath: "/new.jar",
                dependencies: [],
            },
        ] as any);

        // Filter to 1.21 — oldmod (1.20) should be excluded from pool
        const result = await findMissingDeps("1.21") as any;
        expect(result.modsChecked).toBe(1);
        expect(result.unsatisfied).toBe(0);
    });

    it("handles mods with empty or null dependencies gracefully", async () => {
        vi.mocked(listAllMods).mockResolvedValue([
            {
                id: 1, modId: "nodeps", displayName: "No Deps", version: "1.0",
                mcVersion: "1.21", loader: "neoforge", jarPath: "/nd.jar",
                dependencies: [],
            },
            {
                id: 2, modId: "nulldeps", displayName: "Null Deps", version: "1.0",
                mcVersion: "1.21", loader: "neoforge", jarPath: "/null.jar",
                dependencies: null,
            },
        ] as any);

        const result = await findMissingDeps() as any;
        expect(result.unsatisfied).toBe(0);
    });
});
