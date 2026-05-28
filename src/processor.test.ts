import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseJar, parseAtEntries, parseAwEntries, computeMurmur2, parseClassForModAnnotation } from "./processor.js";

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
            expect(m.metadataSource).toBe("fabric.mod.json");
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
            expect(m.metadataSource).toBe("mods.toml");
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

// ── mcmod.info (legacy Forge) parsing ──────────────────────────────────────

describe("parseJar — mcmod.info (legacy Forge)", () => {
    it("parses modId, name, version, mcversion from array format", async () => {
        const zip = new AdmZip();
        const mcmodInfo = JSON.stringify([{
            modid: "StevesCarts",
            name: "Steve's Carts 2",
            version: "2.0.0.b18",
            mcversion: "1.7.10",
            description: "A carttastic mod",
            authorList: ["Vswe"],
            dependencies: [],
        }]);
        zip.addFile("mcmod.info", Buffer.from(mcmodInfo, "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-array-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.modId).toBe("StevesCarts");
            expect(m.displayName).toBe("Steve's Carts 2");
            expect(m.version).toBe("2.0.0.b18");
            expect(m.mcVersion).toBe("1.7.10");
            expect(m.loader).toBe("forge");
            expect(m.description).toBe("A carttastic mod");
            expect(m.metadataSource).toBe("mcmod.info");
        } finally {
            await unlink(tmpPath);
        }
    });

    it("parses mcmod.info modList wrapper format", async () => {
        const zip = new AdmZip();
        const mcmodInfo = JSON.stringify({ modList: [{
            modid: "TestMod",
            name: "Test Mod",
            version: "1.0.0",
            mcversion: "1.12.2",
        }]});
        zip.addFile("mcmod.info", Buffer.from(mcmodInfo, "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-modlist-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.modId).toBe("TestMod");
            expect(m.displayName).toBe("Test Mod");
            expect(m.version).toBe("1.0.0");
            expect(m.mcVersion).toBe("1.12.2");
            expect(m.loader).toBe("forge");
        } finally {
            await unlink(tmpPath);
        }
    });

    it("falls through to unknownMod when mcmod.info is malformed", async () => {
        const zip = new AdmZip();
        zip.addFile("mcmod.info", Buffer.from("not json at all", "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-bad-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.loader).toBe("unknown");
        } finally {
            await unlink(tmpPath);
        }
    });

    it("filters out Forge/FML pseudo-dependencies", async () => {
        const zip = new AdmZip();
        const mcmodInfo = JSON.stringify([{
            modid: "mymod",
            name: "My Mod",
            version: "1.0.0",
            mcversion: "1.7.10",
            dependencies: ["Forge", "FML", "SomeMod"],
        }]);
        zip.addFile("mcmod.info", Buffer.from(mcmodInfo, "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-deps-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.dependencies).toHaveLength(1);
            expect(m.dependencies[0].id).toBe("SomeMod");
        } finally {
            await unlink(tmpPath);
        }
    });

    it("detects AT from META-INF/accesstransformer.cfg in legacy jar", async () => {
        const zip = new AdmZip();
        zip.addFile("mcmod.info", Buffer.from(JSON.stringify([{ modid: "mymod", version: "1.0" }]), "utf8"));
        zip.addFile("META-INF/accesstransformer.cfg", Buffer.from("# at\naccessible field net/minecraft/A f I", "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-at-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.hasAt).toBe(true);
            expect(m.atEntries).toContain("accessible field net/minecraft/A f I");
        } finally {
            await unlink(tmpPath);
        }
    });
});

describe("parseJar — metadataSource fallback", () => {
    it("sets metadataSource to 'filename' when no metadata is found", async () => {
        const zip = new AdmZip();
        zip.addFile("com/example/Util.class", Buffer.from("not a real class"));
        const tmpPath = join(tmpdir(), `my-cool-mod-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.metadataSource).toBe("filename");
            expect(m.loader).toBe("unknown");
        } finally {
            await unlink(tmpPath);
        }
    });
});

// ── @Mod annotation bytecode extraction ────────────────────────────────────

/**
 * Build a minimal valid .class file with a Forge @Mod annotation.
 * The class file has a proper constant pool and RuntimeVisibleAnnotations attribute.
 */
function buildForgeModClassFile(opts: {
    descriptor: string;
    modId: string;
    name?: string;
    version?: string;
    elementNameForId?: string; // default "modid", can be "value" for alt format
}): Buffer {
    const cpEntries: Buffer[] = [];
    function addUtf8(str: string): number {
        const bytes = Buffer.from(str, "utf8");
        const entry = Buffer.alloc(3 + bytes.length);
        entry[0] = 1;
        entry.writeUInt16BE(bytes.length, 1);
        bytes.copy(entry, 3);
        cpEntries.push(entry);
        return cpEntries.length; // 1-based
    }
    function addClass(nameIdx: number): number {
        const entry = Buffer.alloc(3);
        entry[0] = 7;
        entry.writeUInt16BE(nameIdx, 1);
        cpEntries.push(entry);
        return cpEntries.length;
    }

    const thisNameIdx = addUtf8("com/example/TestMod");
    const thisClassIdx = addClass(thisNameIdx);
    const superNameIdx = addUtf8("java/lang/Object");
    const superClassIdx = addClass(superNameIdx);
    const descriptorIdx = addUtf8(opts.descriptor);
    const rvaNameIdx = addUtf8("RuntimeVisibleAnnotations");

    // Build annotation element-value pairs
    const pairs: Array<{ nameIdx: number; valueIdx: number }> = [];
    const idLabel = opts.elementNameForId ?? "modid";
    pairs.push({ nameIdx: addUtf8(idLabel), valueIdx: addUtf8(opts.modId) });
    if (opts.name) pairs.push({ nameIdx: addUtf8("name"), valueIdx: addUtf8(opts.name) });
    if (opts.version) pairs.push({ nameIdx: addUtf8("version"), valueIdx: addUtf8(opts.version) });

    // Annotation data: num_annotations(2) + type_index(2) + num_pairs(2) + pairs*(name(2)+tag(1)+value(2))
    const annotLen = 2 + 2 + 2 + pairs.length * 5;
    const annotData = Buffer.alloc(annotLen);
    let ao = 0;
    annotData.writeUInt16BE(1, ao); ao += 2;
    annotData.writeUInt16BE(descriptorIdx, ao); ao += 2;
    annotData.writeUInt16BE(pairs.length, ao); ao += 2;
    for (const p of pairs) {
        annotData.writeUInt16BE(p.nameIdx, ao); ao += 2;
        annotData[ao++] = 0x73; // 's' tag
        annotData.writeUInt16BE(p.valueIdx, ao); ao += 2;
    }

    // Header: magic(4) + minor(2) + major(2) + cp_count(2) = 10
    const header = Buffer.alloc(10);
    header.writeUInt32BE(0xCAFEBABE, 0);
    header.writeUInt16BE(0, 4);
    header.writeUInt16BE(52, 6); // Java 8
    header.writeUInt16BE(cpEntries.length + 1, 8);

    // Class body: access(2) + this(2) + super(2) + ifaces_count(2) + fields_count(2) + methods_count(2) + attrs_count(2)
    const bodyHeader = Buffer.alloc(14);
    let bo = 0;
    bodyHeader.writeUInt16BE(0x0021, bo); bo += 2; // public + super
    bodyHeader.writeUInt16BE(thisClassIdx, bo); bo += 2;
    bodyHeader.writeUInt16BE(superClassIdx, bo); bo += 2;
    bodyHeader.writeUInt16BE(0, bo); bo += 2; // interfaces
    bodyHeader.writeUInt16BE(0, bo); bo += 2; // fields
    bodyHeader.writeUInt16BE(0, bo); bo += 2; // methods
    bodyHeader.writeUInt16BE(1, bo); bo += 2; // 1 attribute

    // Attribute header: name_index(2) + length(4)
    const attrHeader = Buffer.alloc(6);
    attrHeader.writeUInt16BE(rvaNameIdx, 0);
    attrHeader.writeUInt32BE(annotLen, 2);

    return Buffer.concat([header, ...cpEntries, bodyHeader, attrHeader, annotData]);
}

describe("parseClassForModAnnotation", () => {
    it("extracts modid from cpw.mods.fml.common.Mod (1.7.10 descriptor)", () => {
        const classFile = buildForgeModClassFile({
            descriptor: "Lcpw/mods/fml/common/Mod;",
            modId: "StevesCarts",
            name: "Steve's Carts 2",
            version: "2.0.0.b18",
        });
        const result = parseClassForModAnnotation(classFile);
        expect(result).not.toBeNull();
        expect(result!.modId).toBe("StevesCarts");
        expect(result!.name).toBe("Steve's Carts 2");
        expect(result!.version).toBe("2.0.0.b18");
    });

    it("extracts modid from net.minecraftforge.fml.common.Mod (1.8+ descriptor)", () => {
        const classFile = buildForgeModClassFile({
            descriptor: "Lnet/minecraftforge/fml/common/Mod;",
            modId: "jei",
            name: "Just Enough Items",
            version: "4.15.0",
        });
        const result = parseClassForModAnnotation(classFile);
        expect(result).not.toBeNull();
        expect(result!.modId).toBe("jei");
        expect(result!.name).toBe("Just Enough Items");
    });

    it("handles 'value' element name as alternate for modid", () => {
        const classFile = buildForgeModClassFile({
            descriptor: "Lcpw/mods/fml/common/Mod;",
            modId: "nei",
            elementNameForId: "value",
        });
        const result = parseClassForModAnnotation(classFile);
        expect(result).not.toBeNull();
        expect(result!.modId).toBe("nei");
    });

    it("returns null for class files without @Mod annotation", () => {
        // Build a class with no annotation — just a bare class
        const buf = Buffer.alloc(34);
        let off = 0;
        buf.writeUInt32BE(0xCAFEBABE, off); off += 4; // magic
        buf.writeUInt16BE(0, off); off += 2; // minor
        buf.writeUInt16BE(52, off); off += 2; // major
        buf.writeUInt16BE(4, off); off += 2; // cp_count = 4 (entries #1-#3)
        // #1: Utf8 "TestClass"
        buf[off++] = 1; buf.writeUInt16BE(9, off); off += 2;
        Buffer.from("TestClass").copy(buf, off); off += 9;
        // #2: Class -> #1
        buf[off++] = 7; buf.writeUInt16BE(1, off); off += 2;
        // #3: ditto for super
        // ... truncated — just enough to not match
        expect(parseClassForModAnnotation(buf)).toBeNull();
    });

    it("returns null for non-class-file buffers", () => {
        expect(parseClassForModAnnotation(Buffer.from("not a class file"))).toBeNull();
        expect(parseClassForModAnnotation(Buffer.alloc(4))).toBeNull();
    });
});

describe("parseJar — @Mod annotation fallback", () => {
    it("extracts mod metadata from @Mod annotation when no other metadata exists", async () => {
        const classFile = buildForgeModClassFile({
            descriptor: "Lcpw/mods/fml/common/Mod;",
            modId: "oldmod",
            name: "Old Mod",
            version: "1.0.0",
        });
        const zip = new AdmZip();
        zip.addFile("com/example/OldMod.class", classFile);
        const tmpPath = join(tmpdir(), `test-forge-annotation-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.modId).toBe("oldmod");
            expect(m.displayName).toBe("Old Mod");
            expect(m.version).toBe("1.0.0");
            expect(m.loader).toBe("forge");
            expect(m.metadataSource).toBe("@Mod annotation");
        } finally {
            await unlink(tmpPath);
        }
    });

    it("prefers mcmod.info over @Mod annotation when both exist", async () => {
        const classFile = buildForgeModClassFile({
            descriptor: "Lcpw/mods/fml/common/Mod;",
            modId: "annotation_id",
        });
        const zip = new AdmZip();
        zip.addFile("com/example/Mod.class", classFile);
        zip.addFile("mcmod.info", Buffer.from(JSON.stringify([{
            modid: "mcmodinfo_id",
            name: "Correct Name",
            version: "2.0.0",
            mcversion: "1.7.10",
        }]), "utf8"));
        const tmpPath = join(tmpdir(), `test-prefer-mcmod-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.modId).toBe("mcmodinfo_id");
            expect(m.displayName).toBe("Correct Name");
            expect(m.metadataSource).toBe("mcmod.info");
        } finally {
            await unlink(tmpPath);
        }
    });
});

// ── mcmod.info format variants ────────────────────────────────────────────

describe("parseJar — mcmod.info format variants", () => {
    it("handles bare object format (not array, not modList wrapper)", async () => {
        const zip = new AdmZip();
        zip.addFile("mcmod.info", Buffer.from(JSON.stringify({
            modid: "baremod",
            name: "Bare Mod",
            version: "1.0.0",
            mcversion: "1.6.4",
        }), "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-bare-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.modId).toBe("baremod");
            expect(m.displayName).toBe("Bare Mod");
            expect(m.mcVersion).toBe("1.6.4");
            expect(m.loader).toBe("forge");
        } finally {
            await unlink(tmpPath);
        }
    });

    it("handles modId (camelCase) alternative to modid", async () => {
        const zip = new AdmZip();
        zip.addFile("mcmod.info", Buffer.from(JSON.stringify({
            modId: "camelmod",
            name: "Camel Mod",
            version: "1.0.0",
        }), "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-camel-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.modId).toBe("camelmod");
        } finally {
            await unlink(tmpPath);
        }
    });

    it("handles requiredMods array as dependency source", async () => {
        const zip = new AdmZip();
        zip.addFile("mcmod.info", Buffer.from(JSON.stringify([{
            modid: "depmod",
            version: "1.0.0",
            requiredMods: ["LibraryMod", "Forge"],
        }]), "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-required-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.dependencies).toHaveLength(1);
            expect(m.dependencies[0].id).toBe("LibraryMod");
        } finally {
            await unlink(tmpPath);
        }
    });

    it("parses Forge dependency string format 'required-after:ModId@[1.0,)'", async () => {
        const zip = new AdmZip();
        zip.addFile("mcmod.info", Buffer.from(JSON.stringify([{
            modid: "depmod",
            version: "1.0.0",
            dependencies: ["required-after:SomeLib@[1.0,)", "after:OptionalLib", "Forge"],
        }]), "utf8"));
        const tmpPath = join(tmpdir(), `test-mcmod-depstring-${Date.now()}.jar`);
        zip.writeZip(tmpPath);
        try {
            const m = await parseJar(tmpPath);
            expect(m.dependencies.map(d => d.id)).toContain("SomeLib");
            expect(m.dependencies.map(d => d.id)).toContain("OptionalLib");
            expect(m.dependencies.map(d => d.id)).not.toContain("Forge");
        } finally {
            await unlink(tmpPath);
        }
    });
});

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
