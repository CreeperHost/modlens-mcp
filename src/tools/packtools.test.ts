import { describe, it, expect, vi, beforeEach } from "vitest";
import { findDataConflicts } from "./packtools.js";

vi.mock("../repositories/mod.js", () => ({
    listModsSlim: vi.fn(),
    listMods: vi.fn(),
    findModsByIds: vi.fn(),
    resolveModRef: vi.fn(),
}));
vi.mock("../jar.js", () => ({
    listEntries: vi.fn(),
}));
vi.mock("../java-tools.js", () => ({
    indexJar: vi.fn(),
}));

import { listModsSlim } from "../repositories/mod.js";
import { listEntries } from "../jar.js";

const MOD_A = { id: 1, modId: "mod_a", displayName: "Mod A", version: "1.0", jarPath: "/a.jar", loader: "neoforge", mcVersion: "1.21" };
const MOD_B = { id: 2, modId: "mod_b", displayName: "Mod B", version: "1.0", jarPath: "/b.jar", loader: "neoforge", mcVersion: "1.21" };

describe("findDataConflicts", () => {
    beforeEach(() => vi.resetAllMocks());

    it("detects vanilla override conflict across two mods", async () => {
        vi.mocked(listModsSlim).mockResolvedValue([MOD_A, MOD_B] as any);
        vi.mocked(listEntries)
            .mockReturnValueOnce([
                "data/minecraft/recipe/oak_planks.json",
                "data/mymod/recipe/copper_thing.json",
            ])
            .mockReturnValueOnce([
                "data/minecraft/recipe/oak_planks.json",
            ]);

        const result = await findDataConflicts() as any;

        expect(result.totalConflicts).toBe(1);
        expect(result.modsScanned).toBe(2);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].path).toBe("data/minecraft/recipe/oak_planks.json");
        expect(result.conflicts[0].isVanillaOverride).toBe(true);
        expect(result.conflicts[0].modCount).toBe(2);
        expect(result.vanillaOverrideConflicts).toBe(1);
    });

    it("filters by dataType", async () => {
        vi.mocked(listModsSlim).mockResolvedValue([MOD_A, MOD_B] as any);
        vi.mocked(listEntries)
            .mockReturnValueOnce([
                "data/minecraft/recipe/oak_planks.json",
                "data/minecraft/loot_tables/blocks/stone.json",
            ])
            .mockReturnValueOnce([
                "data/minecraft/recipe/oak_planks.json",
                "data/minecraft/loot_tables/blocks/stone.json",
            ]);

        const result = await findDataConflicts("recipe") as any;
        expect(result.totalConflicts).toBe(1);
        expect(result.conflicts[0].path).toContain("/recipe/");
    });

    it("returns no conflicts when all paths are unique", async () => {
        vi.mocked(listModsSlim).mockResolvedValue([MOD_A] as any);
        vi.mocked(listEntries).mockReturnValueOnce(["data/mymod/recipe/thing.json"]);

        const result = await findDataConflicts() as any;
        expect(result.totalConflicts).toBe(0);
        expect(result.conflicts).toHaveLength(0);
    });

    it("skips directory entries (trailing slash)", async () => {
        vi.mocked(listModsSlim).mockResolvedValue([MOD_A, MOD_B] as any);
        vi.mocked(listEntries)
            .mockReturnValueOnce(["data/minecraft/recipe/", "data/minecraft/recipe/wood.json"])
            .mockReturnValueOnce(["data/minecraft/recipe/", "data/minecraft/recipe/wood.json"]);

        const result = await findDataConflicts() as any;
        // Directory entry should not count; only the .json file
        expect(result.totalConflicts).toBe(1);
        expect(result.conflicts[0].path.endsWith("/")).toBe(false);
    });

    it("builds byType breakdown correctly", async () => {
        vi.mocked(listModsSlim).mockResolvedValue([MOD_A, MOD_B] as any);
        vi.mocked(listEntries)
            .mockReturnValueOnce([
                "data/minecraft/recipe/wood.json",
                "data/minecraft/loot_tables/stone.json",
            ])
            .mockReturnValueOnce([
                "data/minecraft/recipe/wood.json",
                "data/minecraft/loot_tables/stone.json",
            ]);

        const result = await findDataConflicts() as any;
        expect(result.byType.recipe).toBe(1);
        expect(result.byType.loot_tables).toBe(1);
    });

    it("caps results at limit", async () => {
        vi.mocked(listModsSlim).mockResolvedValue([MOD_A, MOD_B] as any);
        // Generate 5 shared paths
        const paths = Array.from({ length: 5 }, (_, i) => `data/minecraft/recipe/item_${i}.json`);
        vi.mocked(listEntries)
            .mockReturnValueOnce(paths)
            .mockReturnValueOnce(paths);

        const result = await findDataConflicts("all", undefined, undefined, 3) as any;
        expect(result.conflicts).toHaveLength(3);
        expect(result.capped).toBe(true);
    });
});
