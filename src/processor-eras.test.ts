import { afterEach, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJar } from "./processor.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function parseFixture(files: Record<string, string>) {
    const directory = await mkdtemp(join(tmpdir(), "modlens-manifest-era-"));
    temporaryDirectories.push(directory);
    const archive = new AdmZip();
    for (const [name, content] of Object.entries(files)) archive.addFile(name, Buffer.from(content));
    const path = join(directory, "fixture-1.0.jar");
    archive.writeZip(path);
    return parseJar(path);
}

describe("Forge manifest formats across Minecraft eras", () => {
    it.each([
        ["1.2.5", (mod: object) => [mod]],
        ["1.4.7", (mod: object) => ({ modListVersion: 2, modList: [mod] })],
        ["1.6.4", (mod: object) => mod],
        ["1.7.10", (mod: object) => [mod]],
        ["1.8.9", (mod: object) => [mod]],
        ["1.12.2", (mod: object) => [mod]],
    ] as const)("reads %s mcmod.info and preserves dependency semantics", async (mcVersion, wrap) => {
        const manifest = await parseFixture({
            "mcmod.info": JSON.stringify(wrap({
                modid: "fixture", name: "Fixture", version: "1.0", mcversion: mcVersion,
                dependencies: ["library@[1.2,2.0)", "after:optional@[2.0,)", "required-after:Forge@[9.0,)", "after:*"],
                requiredMods: ["library@[1.2,2.0)"],
            })),
        });
        expect(manifest).toMatchObject({ modId: "fixture", version: "1.0", mcVersion, loader: "forge" });
        expect(manifest.dependencies).toEqual([
            { id: "library", version: "[1.2,2.0)", required: true },
            { id: "optional", version: "[2.0,)", required: false },
        ]);
    });

    it.each(["1.6.4", "1.7.10", "1.12.2"])("finds %s FMLAT files, including folded manifest headers", async mcVersion => {
        const manifest = await parseFixture({
            "mcmod.info": JSON.stringify([{ modid: "fixture", mcversion: mcVersion }]),
            "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\r\nFMLAT: fixture_at.cfg\r\n  shared_at.cfg\r\n\r\n",
            "META-INF/fixture_at.cfg": "public net.minecraft.world.World field_72995_K # world side\n",
            "META-INF/shared_at.cfg": "public-f net.minecraft.block.Block field_149782_v\n",
        });
        expect(manifest.hasAt).toBe(true);
        expect(manifest.atEntries).toEqual([
            "public net.minecraft.world.World field_72995_K",
            "public-f net.minecraft.block.Block field_149782_v",
        ]);
    });

    it.each(["1.14.4", "1.16.5", "1.18.2", "1.20.1"])("reads %s mods.toml and the JAR implementation version", async mcVersion => {
        const manifest = await parseFixture({
            "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\nImplementation-Version: 2.4.6\n\n",
            "META-INF/mods.toml": `modLoader="javafml"\n[[mods]]\nmodId="fixture"\nversion="\${file.jarVersion}"\n[[dependencies.fixture]]\nmodId="minecraft"\nmandatory=true\nversionRange="[${mcVersion}]"\n[[dependencies.fixture]]\nmodId="optional"\nmandatory=false\nversionRange="[1,)"\n`,
        });
        expect(manifest).toMatchObject({ version: "2.4.6", mcVersion: `[${mcVersion}]`, loader: "forge" });
        expect(manifest.dependencies).toEqual([{ id: "optional", version: "[1,)", required: false }]);
    });

    it.each([
        ["1.20.1", "META-INF/mods.toml", "mandatory=false"],
        ["1.20.4", "META-INF/mods.toml", 'type="optional"'],
        ["1.20.6", "META-INF/neoforge.mods.toml", 'type="optional"'],
        ["1.21.1", "META-INF/neoforge.mods.toml", 'type="optional"'],
    ])("detects NeoForge %s and optional dependency declarations", async (mcVersion, file, optional) => {
        const manifest = await parseFixture({
            [file]: `modLoader="javafml"\n[[mods]]\nmodId="fixture"\nversion="1.0"\n[[dependencies.fixture]]\nmodId="neoforge"\nversionRange="[1,)"\n[[dependencies.fixture]]\nmodId="minecraft"\nversionRange="[${mcVersion}]"\n[[dependencies.fixture]]\nmodId="optional"\n${optional}\nversionRange="[2,)"\n`,
        });
        expect(manifest).toMatchObject({ loader: "neoforge", mcVersion: `[${mcVersion}]` });
        expect(manifest.dependencies).toEqual([{ id: "optional", version: "[2,)", required: false }]);
    });
});

describe("Fabric and Quilt metadata", () => {
    it.each(["1.14.4", "1.16.5", "1.18.2", "1.20.1", "1.21.1"])("reads %s declared mixin names and optional dependencies", async mcVersion => {
        const manifest = await parseFixture({
            "fabric.mod.json": JSON.stringify({
                schemaVersion: 1, id: "fixture", version: "1.0", depends: { minecraft: [mcVersion, "1.99.x"] },
                recommends: { optional: ">=2" }, mixins: ["mixins.fixture.json", { config: "client.json", environment: "client" }],
                accessWidener: "fixture.accesswidener",
            }),
            "mixins.fixture.json": JSON.stringify({ package: "example", mixins: ["CommonMixin"] }),
            "client.json": JSON.stringify({ package: "example", client: ["ClientMixin"] }),
            "fixture.accesswidener": "accessWidener v1 intermediary\naccessible class net/minecraft/class_1937\n",
        });
        expect(manifest.mcVersion).toBe(`${mcVersion} || 1.99.x`);
        expect(manifest.dependencies).toContainEqual({ id: "optional", version: ">=2", required: false });
        expect(manifest.mixinConfigs).toEqual(["mixins.fixture.json", "client.json"]);
        expect(manifest.mixinTargets).toEqual(["example.CommonMixin", "example.ClientMixin"]);
        expect(manifest.awEntries).toEqual(["accessible class net/minecraft/class_1937"]);
    });

    it("reads Quilt 1.19.2 dependencies, source URL, and its singular mixin key", async () => {
        const manifest = await parseFixture({
            "quilt.mod.json": JSON.stringify({
                schema_version: 1,
                quilt_loader: {
                    id: "fixture", version: "1.0",
                    metadata: { name: "Fixture", description: "Quilt fixture", contact: { sources: "https://example.invalid/source" } },
                    depends: [{ id: "minecraft", versions: "~1.19.2" }, { id: "library", versions: ">=1.0", optional: true }],
                },
                mixin: "mixins.fixture.json",
            }),
            "mixins.fixture.json": JSON.stringify({ package: "example", mixins: ["QuiltMixin"] }),
        });
        expect(manifest).toMatchObject({ loader: "quilt", mcVersion: "~1.19.2", description: "Quilt fixture", sourceUrl: "https://example.invalid/source" });
        expect(manifest.dependencies).toContainEqual({ id: "library", version: ">=1.0", required: false });
        expect(manifest.mixinTargets).toEqual(["example.QuiltMixin"]);
    });
});
