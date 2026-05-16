import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseJar, parseAtEntries, parseAwEntries, computeMurmur2 } from "./processor.js";

// ── AT / AW entry parsing ──────────────────────────────────────────────────

describe("parseAtEntries", () => {
    it("returns empty array for empty string", () => {
        expect(parseAtEntries("")).toEqual([]);
    });

    it("strips comment lines starting with #", () => {
        const input = "# This is a comment\naccessible field net/minecraft/world/World field_1234 I";
        expect(parseAtEntries(input)).toEqual([
            "accessible field net/minecraft/world/World field_1234 I",
        ]);
    });

    it("strips blank lines", () => {
        const input = "\n\naccessible method net/minecraft/A foo ()V\n\n";
        expect(parseAtEntries(input)).toEqual([
            "accessible method net/minecraft/A foo ()V",
        ]);
    });

    it("preserves multiple valid entries", () => {
        const input = [
            "# comment",
            "accessible class net/minecraft/world/World",
            "accessible field net/minecraft/world/World field_1234 I",
            "accessible method net/minecraft/world/World func_1234 ()V",
        ].join("\n");
        expect(parseAtEntries(input)).toHaveLength(3);
        expect(parseAtEntries(input)[0]).toBe("accessible class net/minecraft/world/World");
    });
});

describe("parseAwEntries", () => {
    it("returns empty array for empty string", () => {
        expect(parseAwEntries("")).toEqual([]);
    });

    it("strips the accessWidener header line", () => {
        const input = "accessWidener v2 named\naccessible class net/minecraft/world/World";
        expect(parseAwEntries(input)).toEqual([
            "accessible class net/minecraft/world/World",
        ]);
    });

    it("strips comment lines starting with #", () => {
        const input = "# comment\naccessible field net/minecraft/A field I";
        expect(parseAwEntries(input)).toEqual([
            "accessible field net/minecraft/A field I",
        ]);
    });

    it("strips blank lines", () => {
        const input = "\naccessible method net/minecraft/A foo ()V\n\n";
        expect(parseAwEntries(input)).toEqual([
            "accessible method net/minecraft/A foo ()V",
        ]);
    });
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function makeFabricJar(fabricJson: object, extras: Record<string, string> = {}): Promise<string> {
    const zip = new AdmZip();
    zip.addFile("fabric.mod.json", Buffer.from(JSON.stringify(fabricJson), "utf8"));
    for (const [name, content] of Object.entries(extras)) {
        zip.addFile(name, Buffer.from(content, "utf8"));
    }
    const dest = join(tmpdir(), `test-fabric-${Date.now()}.jar`);
    zip.writeZip(dest);
    return dest;
}

async function makeNeoForgeJar(toml: string, extras: Record<string, string> = {}): Promise<string> {
    const zip = new AdmZip();
    zip.addFile("META-INF/neoforge.mods.toml", Buffer.from(toml, "utf8"));
    for (const [name, content] of Object.entries(extras)) {
        zip.addFile(name, Buffer.from(content, "utf8"));
    }
    const dest = join(tmpdir(), `test-neoforge-${Date.now()}.jar`);
    zip.writeZip(dest);
    return dest;
}

// ── Fabric manifest parsing ────────────────────────────────────────────────

describe("parseJar — Fabric", () => {
    it("parses modId, displayName, version from fabric.mod.json", async () => {
        const jarPath = await makeFabricJar({
            id: "mymod",
            name: "My Mod",
            version: "1.2.3",
            depends: { minecraft: "1.21.1" },
        });
        try {
            const m = await parseJar(jarPath);
            expect(m.modId).toBe("mymod");
            expect(m.displayName).toBe("My Mod");
            expect(m.version).toBe("1.2.3");
            expect(m.loader).toBe("fabric");
            expect(m.mcVersion).toBe("1.21.1");
        } finally {
            await unlink(jarPath);
        }
    });

    it("detects mixin configs from JAR entries", async () => {
        const jarPath = await makeFabricJar(
            { id: "mymod", version: "1.0.0", depends: {} },
            { "mymod.mixins.json": JSON.stringify({ package: "com.example", mixins: ["MyMixin"] }) },
        );
        try {
            const m = await parseJar(jarPath);
            expect(m.hasMixins).toBe(true);
            expect(m.mixinConfigs).toContain("mymod.mixins.json");
            expect(m.mixinTargets).toContain("com.example.MyMixin");
        } finally {
            await unlink(jarPath);
        }
    });

    it("extracts sourceUrl from contact.sources", async () => {
        const jarPath = await makeFabricJar({
            id: "mymod",
            version: "1.0.0",
            depends: {},
            contact: { sources: "https://github.com/example/mymod" },
        });
        try {
            const m = await parseJar(jarPath);
            expect(m.sourceUrl).toBe("https://github.com/example/mymod");
        } finally {
            await unlink(jarPath);
        }
    });

    it("detects access widener", async () => {
        const jarPath = await makeFabricJar(
            { id: "mymod", version: "1.0.0", depends: {} },
            { "mymod.accesswidener": "accessWidener v2 named\naccessible class net/minecraft/world/World" },
        );
        try {
            const m = await parseJar(jarPath);
            expect(m.hasAw).toBe(true);
            expect(m.awEntries).toContain("accessible class net/minecraft/world/World");
        } finally {
            await unlink(jarPath);
        }
    });
});

// ── NeoForge manifest parsing ──────────────────────────────────────────────

describe("parseJar — NeoForge", () => {
    it("parses modId, version, displayName from TOML", async () => {
        const toml = `
[[mods]]
modId = "examplemod"
version = "2.0.0"
displayName = "Example Mod"
description = "A test mod"

[[dependencies.examplemod]]
modId = "minecraft"
versionRange = "[26.1.2,)"
mandatory = true
`;
        const jarPath = await makeNeoForgeJar(toml);
        try {
            const m = await parseJar(jarPath);
            expect(m.modId).toBe("examplemod");
            expect(m.version).toBe("2.0.0");
            expect(m.displayName).toBe("Example Mod");
            expect(m.loader).toBe("neoforge");
            expect(m.mcVersion).toBe("[26.1.2,)");
        } finally {
            await unlink(jarPath);
        }
    });

    it("extracts non-minecraft, non-neoforge dependencies", async () => {
        const toml = `
[[mods]]
modId = "mymod"
version = "1.0.0"

[[dependencies.mymod]]
modId = "minecraft"
versionRange = "[26.1.2,)"
mandatory = true

[[dependencies.mymod]]
modId = "jei"
versionRange = "[19.0,)"
mandatory = false
`;
        const jarPath = await makeNeoForgeJar(toml);
        try {
            const m = await parseJar(jarPath);
            expect(m.dependencies).toHaveLength(1);
            expect(m.dependencies[0].id).toBe("jei");
            expect(m.dependencies[0].required).toBe(false);
        } finally {
            await unlink(jarPath);
        }
    });

    it("detects AT from META-INF/accesstransformer.cfg presence", async () => {
        const toml = `[[mods]]\nmodId = "mymod"\nversion = "1.0.0"\n`;
        const jarPath = await makeNeoForgeJar(toml, {
            "META-INF/accesstransformer.cfg": "# comment\naccessible field net/minecraft/A f I",
        });
        try {
            const m = await parseJar(jarPath);
            expect(m.hasAt).toBe(true);
            expect(m.atEntries).toContain("accessible field net/minecraft/A f I");
        } finally {
            await unlink(jarPath);
        }
    });
});

// ── Murmur2 hash ───────────────────────────────────────────────────────────

describe("computeMurmur2", () => {
    it("returns a number and does not throw for empty buffer", () => {
        const result = computeMurmur2(Buffer.alloc(0));
        expect(typeof result).toBe("number");
    });

    it("filters whitespace bytes (9, 10, 13, 32) before hashing", () => {
        const withWhitespace    = Buffer.from([0x61, 0x20, 0x62, 0x0a, 0x63]); // a ' ' b '\n' c
        const withoutWhitespace = Buffer.from([0x61, 0x62, 0x63]);              // abc
        expect(computeMurmur2(withWhitespace)).toBe(computeMurmur2(withoutWhitespace));
    });

    it("returns different hashes for different byte content", () => {
        const a = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        const b = Buffer.from([0x04, 0x03, 0x02, 0x01]);
        expect(computeMurmur2(a)).not.toBe(computeMurmur2(b));
    });

    it("is deterministic — same input always gives same output", () => {
        const buf = Buffer.from("hello world modlens test", "utf8");
        expect(computeMurmur2(buf)).toBe(computeMurmur2(buf));
    });
});
