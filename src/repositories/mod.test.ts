import { afterEach, describe, it, expect, vi } from "vitest";
import { mcVersionWhere, resolveModRef, resolveModRefSlim } from "./mod.js";
const database = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() }));
afterEach(() => vi.clearAllMocks());
vi.mock("../db.js", () => ({getDb: async () => ({mod: database})}));
const versions = [
    "1.21.1", "1.21.11", "1.21.1.0", "1.211", "[1.21.1,)", "[1.21,1.22)", ">=1.21 <1.22",
    "1.7.2", "1.7.10", "[1.7.10,1.8)", "1.12.2", "[1.12,1.13)", ">=1.16.2 <1.17",
].map(mcVersion=>({mcVersion}));
database.findMany.mockImplementation(async (args: any) => args?.distinct?.includes("mcVersion") ? versions : []);

describe("mcVersionWhere", () => {
    it.each([
        ["1.7.10", ["1.7.10", "[1.7.10,1.8)"]],
        ["1.12.2", ["1.12.2", "[1.12,1.13)"]],
        ["1.16.5", [">=1.16.2 <1.17"]],
    ])("filters stored legacy declarations for %s", async (version, declarations) => {
        expect(await mcVersionWhere(version as string)).toEqual({ mcVersion: { in: declarations } });
    });
    it("matches exact versions and compatible Maven/Fabric declarations", async () => {
        expect(await mcVersionWhere("1.21.1")).toEqual({mcVersion:{in:[
            "1.21.1", "1.21.1.0", "[1.21.1,)", "[1.21,1.22)", ">=1.21 <1.22",
        ]}});
    });

    it("does not pull in a different patch", async () => {
        const where = await mcVersionWhere("1.21.1");
        expect((where.mcVersion as {in:string[]}).in).not.toContain("1.21.11");
    });

    it("treats a partial version as a family prefix (1.21 → all 1.21.x)", async () => {
        const where = await mcVersionWhere("1.21");
        expect((where.mcVersion as {in:string[]}).in).toEqual(expect.arrayContaining(["1.21.1", "1.21.11"]));
        expect((where.mcVersion as {in:string[]}).in).not.toContain("1.211");
    });
});

describe.each([resolveModRef, resolveModRefSlim])("mod reference resolution", resolve => {
    it.each([undefined, null, ""])("does not query the first record for a missing reference (%s)", async ref => {
        expect(await resolve(ref as any)).toBeNull();
        expect(database.findMany).not.toHaveBeenCalled();
        expect(database.findUnique).not.toHaveBeenCalled();
    });
    it("does not interpret a mod name's numeric prefix as a database ID", async () => {
        await resolve("3d-example");
        expect(database.findUnique).not.toHaveBeenCalled();
        expect(database.findMany).toHaveBeenCalledOnce();
    });
    it("does not select an integration mod by substring", async () => {
        database.findMany.mockResolvedValueOnce([{ modId: "refinedstorage_mekanism_integration", id: 9 }]);
        expect(await resolve("Mekanism")).toBeNull();
    });
    it("rejects ambiguous exact releases", async () => {
        database.findMany.mockResolvedValueOnce([{ modId: "mekanism", id: 1 }, { modId: "Mekanism", id: 2 }]);
        await expect(resolve("Mekanism")).rejects.toThrow("Multiple releases");
    });
});
