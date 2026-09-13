import { afterEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../repositories/mod.js", () => ({ resolveModRef: vi.fn(), findModById: vi.fn(), listModsSlim: vi.fn() }));
const { resolveModRef } = await import("../repositories/mod.js");
const { getModData, listModData, getModLang } = await import("./mod-data.js");
const directories: string[] = [];

afterEach(async () => {
    vi.resetAllMocks();
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>) {
    const directory = await mkdtemp(join(tmpdir(), "modlens-data-era-"));
    directories.push(directory);
    const jarPath = join(directory, "fixture.jar");
    const zip = new AdmZip();
    for (const [path, content] of Object.entries(files)) zip.addFile(path, Buffer.from(content));
    zip.writeZip(jarPath);
    vi.mocked(resolveModRef).mockResolvedValue({ modId: "fixture", jarPath } as any);
}

describe("resource layouts across Minecraft eras", () => {
    it.each([
        ["1.9.4", "loot_table", "assets/fixture/loot_tables/chests/example.json", "lootTables"],
        ["1.12.2", "recipe", "assets/fixture/recipes/example.json", "recipes"],
        ["1.12.2", "advancement", "assets/fixture/advancements/story/example.json", "advancements"],
        ["1.13.2", "recipe", "data/fixture/recipes/example.json", "recipes"],
        ["1.16.5", "loot_table", "data/fixture/loot_tables/chests/example.json", "lootTables"],
        ["1.18.2", "advancement", "data/fixture/advancements/story/example.json", "advancements"],
        ["1.20.1", "recipe", "data/fixture/recipes/example.json", "recipes"],
        ["1.20.6", "recipe", "data/fixture/recipes/example.json", "recipes"],
        ["1.21.1", "recipe", "data/fixture/recipe/example.json", "recipes"],
        ["1.21.1", "loot_table", "data/fixture/loot_table/chests/example.json", "lootTables"],
        ["1.21.1", "advancement", "data/fixture/advancement/story/example.json", "advancements"],
    ])("lists and reads %s %s resources", async (_version, type, path, key) => {
        const data = { fixture: true };
        await fixture({ [path]: JSON.stringify(data) });
        const id = "fixture:" + path.split("/").slice(3).join("/").replace(/\.json$/, "");
        expect(await listModData("fixture", type)).toMatchObject({ count: 1, [key]: [id] });
        expect(await getModData("fixture", type, id)).toMatchObject({ id, data });
    });

    it("combines resource directory variants without duplicating IDs or leaking an explicit namespace", async () => {
        await fixture({
            "data/fixture/recipe/current.json": "{}", "data/fixture/recipes/older.json": "{}",
            "assets/fixture/recipes/older.json": "{}", "data/another/recipe/foreign.json": "{}",
        });
        expect(await listModData("fixture", "recipe")).toMatchObject({ count: 2, recipes: ["fixture:current", "fixture:older"] });
        expect(await listModData("fixture", "recipe", { namespace: "missing" })).toMatchObject({ count: 0, recipes: [] });
    });
});

describe("language formats across Minecraft eras", () => {
    it.each([
        ["1.2.5", "lang/en_US.lang"],
        ["1.6.4", "assets/fixture/lang/en_US.lang"],
        ["1.7.10", "assets/fixture/lang/en_US.lang"],
        ["1.8.9", "assets/fixture/lang/en_US.lang"],
        ["1.12.2", "assets/fixture/lang/en_us.lang"],
    ])("reads %s key=value language files", async (_version, path) => {
        await fixture({ [path]: "# comment\nitem.fixture.name=Example=Value\n\ninvalid\ntile.fixture.name=Block\n" });
        expect(await getModLang("fixture")).toMatchObject({ total: 2, entries: {
            "item.fixture.name": "Example=Value", "tile.fixture.name": "Block",
        } });
        expect(await getModLang("fixture", "block", 1)).toMatchObject({ total: 2, shown: 1, entries: { "tile.fixture.name": "Block" } });
    });

    it.each(["1.13.2", "1.16.5", "1.20.1", "1.21.1"])("reads %s JSON language files", async () => {
        await fixture({ "assets/fixture/lang/en_us.json": '{"item.fixture.example":"Example"}' });
        expect(await getModLang("fixture")).toMatchObject({ total: 1, entries: { "item.fixture.example": "Example" } });
    });
});
