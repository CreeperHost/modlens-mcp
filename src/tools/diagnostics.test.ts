import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeCrashLog, findMissingDeps } from "./diagnostics.js";

vi.mock("../repositories/mod.js", () => ({
    findModClassesByClassNames: vi.fn(),
    listAllMods: vi.fn(),
}));

vi.mock("../modpacks-ch.js", () => ({
    searchMods: vi.fn(),
    getModsBatch: vi.fn(),
}));

vi.mock("./modpacks-ch.js", () => ({
    downloadModAction: vi.fn(),
}));

import { findModClassesByClassNames, listAllMods } from "../repositories/mod.js";
import { searchMods, getModsBatch } from "../modpacks-ch.js";
import { downloadModAction } from "./modpacks-ch.js";

const SAMPLE_CRASH = `
---- Minecraft Crash Report ----
java.lang.NullPointerException: Cannot invoke method
	at net.minecraft.world.level.Level.tickChunk(Level.java:345)
	at com.example.mymod.MyWorldMixin.tickChunk(MyWorldMixin.java:12)
	at net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:890)
	at com.example.other.OtherMixin.runServer(OtherMixin.java:5)
	at com.example.other.OtherMixin.extra(OtherMixin.java:30)

-- Mod List --
mymod|1.0
othermod|2.0
`;

describe("analyzeCrashLog", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(searchMods).mockResolvedValue(null as any);
        vi.mocked(getModsBatch).mockResolvedValue([] as any);
    });

    it("ranks mods by frame count and returns suspects", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([
            { className: "com/example/mymod/MyWorldMixin",  modId: 1, mod: { modId: "mymod",    displayName: "My Mod"    } },
            { className: "com/example/other/OtherMixin",    modId: 2, mod: { modId: "othermod", displayName: "Other Mod" } },
        ]);

        const result = await analyzeCrashLog(SAMPLE_CRASH) as any;

        expect(result.suspects).toHaveLength(2);
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
        expect(result.coverageWarning).toContain("Fallback crash signals");
    });

    it("falls back when the mod class database is unavailable", async () => {
        vi.mocked(findModClassesByClassNames).mockRejectedValue(new Error("no such table: mod_classes"));
        const crash = `
	at TRANSFORMER/cupboard@3.2/net.satisfy.cupboard.Cupboard.onLoad(Cupboard.java:39) ~[cupboard-1.21-3.2.jar%23123!/:?]
`;
        const result = await analyzeCrashLog(crash) as any;
        expect(result.suspects[0].modId).toBe("cupboard");
        expect(result.recognizedFrames).toBe(0);
    });

    it("returns empty suspects for empty log", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
        const result = await analyzeCrashLog("") as any;
        expect(result.suspects).toHaveLength(0);
        expect(result.totalFrames).toBe(0);
    });

    it("parses mod list sections", async () => {
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

    it("parses modern NeoForge transformer frames and returns fallback suspects", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
        const crash = `
---- Minecraft Crash Report ----
Description: Exception in server tick loop
Minecraft Version: 1.21.1
NeoForge Version: 21.1.172
java.lang.NullPointerException: Cannot read field
	at TRANSFORMER/cupboard@3.2/net.satisfy.cupboard.Cupboard.onLoad(Cupboard.java:39) ~[cupboard-1.21-3.2.jar%23123!/:?]
	at TRANSFORMER/minecraft@1.21.1/net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:900) ~[server.jar%231!/:?]
`;
        const result = await analyzeCrashLog(crash) as any;
        expect(result.totalFrames).toBe(2);
        expect(result.suspects[0].modId).toBe("cupboard");
        expect(result.suspects[0].jars).toContain("cupboard-1.21-3.2.jar");
        expect(result.fallbackSuspects[0].modId).toBe("cupboard");
    });

    it("extracts mod loading issues and missing dependencies", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
        const crash = `
---- Minecraft Crash Report ----
Description: Mod loading error has occurred
Minecraft Version: 1.21.1
-- Mod loading issue for: ars_ocultas --
Details:
	Mod file: /mods/ars_ocultas-2.1.0.jar
	Failure message: Mod ars_ocultas requires occultism 1.203.0 or above
	Currently, occultism is not installed
	Exception message: Missing or unsupported mandatory dependencies
`;
        const result = await analyzeCrashLog(crash) as any;
        expect(result.suspects.map((s: any) => s.modId)).toContain("occultism");
        expect(result.suspects.map((s: any) => s.modId)).toContain("ars_ocultas");
        expect(result.crashFacts.missingDependencies[0].depModId).toBe("occultism");
    });

    it("parses Fabric mod sections and jar-backed frames", async () => {
        vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
        const crash = `
---- Minecraft Crash Report ----
Description: Rendering overlay
	at com.terraformersmc.modmenu.ModMenu.onInitializeClient(ModMenu.java:88) [modmenu-11.0.1.jar:?]
Fabric Mods:
	fabricloader: Fabric Loader 0.16.9
	modmenu: Mod Menu 11.0.1
`;
        const result = await analyzeCrashLog(crash) as any;
        expect(result.modsInLogSection).toContain("modmenu");
        expect(result.suspects.map((s: any) => s.modId)).toContain("modmenu");
    });

    it("can populate a missing top suspect from modpacks.ch and rerun class lookup", async () => {
        vi.mocked(findModClassesByClassNames)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { className: "net/satisfy/cupboard/Cupboard", modId: 7, mod: { modId: "cupboard", displayName: "Cupboard" } },
            ] as any);
        vi.mocked(searchMods).mockResolvedValue({ mods: [123], total: 1, limit: 8, term: "cupboard" } as any);
        vi.mocked(getModsBatch).mockResolvedValue([
            {
                id: 123,
                name: "Cupboard",
                installs: 1000,
                links: [],
                versions: [
                    { id: 456, name: "cupboard-1.21-3.2.jar", targets: [{ type: "game", version: "1.21.1" }, { type: "modloader", name: "neoforge" }] },
                ],
            },
        ] as any);
        vi.mocked(downloadModAction).mockResolvedValue({ status: "ingested", modId: 7, name: "cupboard-1.21-3.2.jar" } as any);
        const crash = `
Minecraft Version: 1.21.1
NeoForge Version: 21.1.172
	at TRANSFORMER/cupboard@3.2/net.satisfy.cupboard.Cupboard.onLoad(Cupboard.java:39) ~[cupboard-1.21-3.2.jar%23123!/:?]
`;
        const result = await analyzeCrashLog(crash) as any;
        expect(downloadModAction).toHaveBeenCalledWith(123, { mcVersion: undefined, loader: undefined, fileId: 456 });
        expect(result.population.attempts[0].status).toBe("ingested");
        expect(result.suspects[0].dbId).toBe(7);
    });

    it("caps suspects at 10", async () => {
        const lines = Array.from({ length: 15 }, (_, i) =>
            `	at com.example.mod${i}.Mixin.method(Mixin.java:1)`
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
                    { id: "minecraft",    version: "1.21", required: true },
                    { id: "neoforge",     version: ">=21", required: true },
                    { id: "java",         version: ">=21", required: true },
                    { id: "fabric-api",   version: "*",    required: false },
                    { id: "fabricloader", version: "*",    required: false },
                    { id: "quilt_loader", version: "*",    required: false },
                    { id: "forge",        version: "*",    required: false },
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