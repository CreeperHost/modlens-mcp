import { describe, it, expect, beforeAll } from "vitest";
import { accessStr, descriptorToSimpleType, formatClassMembers, Opcodes } from "./access-flags.js";
import type { ClassInfo } from "./access-flags.js";

describe("accessStr", () => {
    it("returns public for ACC_PUBLIC", () => {
        expect(accessStr(Opcodes.ACC_PUBLIC)).toBe("public");
    });

    it("returns protected for ACC_PROTECTED", () => {
        expect(accessStr(Opcodes.ACC_PROTECTED)).toBe("protected");
    });

    it("returns private for ACC_PRIVATE", () => {
        expect(accessStr(Opcodes.ACC_PRIVATE)).toBe("private");
    });

    it("returns package-private when no visibility flag is set", () => {
        expect(accessStr(0)).toBe("package-private");
    });

    it("returns package-private for ACC_STATIC alone", () => {
        expect(accessStr(Opcodes.ACC_STATIC)).toBe("package-private");
    });

    it("public takes precedence even when combined with static", () => {
        expect(accessStr(Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC)).toBe("public");
    });

    it("returns private when private+final combined", () => {
        expect(accessStr(Opcodes.ACC_PRIVATE | Opcodes.ACC_FINAL)).toBe("private");
    });
});

describe("descriptorToSimpleType", () => {
    it("converts primitive descriptors", () => {
        expect(descriptorToSimpleType("Z")).toBe("boolean");
        expect(descriptorToSimpleType("B")).toBe("byte");
        expect(descriptorToSimpleType("C")).toBe("char");
        expect(descriptorToSimpleType("S")).toBe("short");
        expect(descriptorToSimpleType("I")).toBe("int");
        expect(descriptorToSimpleType("J")).toBe("long");
        expect(descriptorToSimpleType("F")).toBe("float");
        expect(descriptorToSimpleType("D")).toBe("double");
        expect(descriptorToSimpleType("V")).toBe("void");
    });

    it("converts object descriptor to simple class name", () => {
        expect(descriptorToSimpleType("Ljava/lang/String;")).toBe("String");
        expect(descriptorToSimpleType("Lnet/minecraft/world/entity/LivingEntity;")).toBe("LivingEntity");
    });

    it("converts single-dimension array descriptors", () => {
        expect(descriptorToSimpleType("[I")).toBe("int[]");
        expect(descriptorToSimpleType("[B")).toBe("byte[]");
        expect(descriptorToSimpleType("[Ljava/lang/String;")).toBe("String[]");
    });

    it("converts multi-dimension array descriptors", () => {
        expect(descriptorToSimpleType("[[I")).toBe("int[][]");
        expect(descriptorToSimpleType("[[Ljava/lang/String;")).toBe("String[][]");
    });

    it("returns the descriptor unchanged for unknown single chars", () => {
        expect(descriptorToSimpleType("X")).toBe("X");
    });
});

// ── Shared fixture ─────────────────────────────────────────────────────────
const FIXTURE: ClassInfo = {
    name: "net/minecraft/world/World",
    superName: "net/minecraft/world/level/Level",
    interfaces: ["net/minecraft/world/IWorld"],
    methods: [
        { name: "tick",          descriptor: "(Ljava/util/function/BooleanSupplier;)V", access: Opcodes.ACC_PUBLIC },
        { name: "method_1234",   descriptor: "()V",                                     access: Opcodes.ACC_PUBLIC | Opcodes.ACC_ABSTRACT },
        { name: "privateHelper", descriptor: "(I)Z",                                    access: Opcodes.ACC_PRIVATE },
        { name: "staticFactory", descriptor: "()Lnet/minecraft/world/World;",           access: Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC },
    ],
    fields: [
        { name: "random",    descriptor: "Ljava/util/Random;",                                   access: Opcodes.ACC_PUBLIC },
        { name: "CONSTANT",  descriptor: "I",                                                     access: Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC | Opcodes.ACC_FINAL },
        { name: "dimension", descriptor: "Lnet/minecraft/world/dimension/DimensionType;",        access: Opcodes.ACC_PRIVATE | Opcodes.ACC_FINAL },
    ],
};

describe("formatClassMembers — class-level output", () => {
    it("echoes className and superClass", () => {
        const out = formatClassMembers(FIXTURE);
        expect(out.className).toBe("net/minecraft/world/World");
        expect(out.superClass).toBe("net/minecraft/world/level/Level");
    });

    it("echoes interfaces array", () => {
        const out = formatClassMembers(FIXTURE);
        expect(out.interfaces).toEqual(["net/minecraft/world/IWorld"]);
    });

    it("produces correct AT strings for class access/extendability", () => {
        const out = formatClassMembers(FIXTURE);
        expect(out.atStrings.accessible).toBe("accessible class net/minecraft/world/World");
        expect(out.atStrings.extendable).toBe("extendable class net/minecraft/world/World");
    });
});

describe("formatClassMembers — methods", () => {
    let methods: ReturnType<typeof formatClassMembers>["methods"];
    beforeAll(() => { methods = formatClassMembers(FIXTURE).methods; });

    it("returns one entry per method", () => {
        expect(methods).toHaveLength(4);
    });

    it("echoes name and descriptor", () => {
        expect(methods[0].name).toBe("tick");
        expect(methods[0].descriptor).toBe("(Ljava/util/function/BooleanSupplier;)V");
    });

    it("resolves access string via accessStr", () => {
        expect(methods[0].access).toBe("public");
        expect(methods[2].access).toBe("private");
    });

    it("detects isStatic correctly", () => {
        expect(methods[0].isStatic).toBe(false);  // tick
        expect(methods[3].isStatic).toBe(true);   // staticFactory
    });

    it("detects isFinal correctly", () => {
        expect(methods[0].isFinal).toBe(false);
        expect(methods.every((m) => !m.isFinal)).toBe(true);
    });

    it("detects isAbstract correctly", () => {
        expect(methods[1].isAbstract).toBe(true);  // method_1234
        expect(methods[0].isAbstract).toBe(false); // tick
    });

    it("produces mixinTarget as name+descriptor", () => {
        expect(methods[0].mixinTarget).toBe("tick(Ljava/util/function/BooleanSupplier;)V");
    });

    it("produces AT string in correct format", () => {
        expect(methods[0].atString).toBe(
            "accessible method net/minecraft/world/World tick (Ljava/util/function/BooleanSupplier;)V",
        );
    });
});

describe("formatClassMembers — fields", () => {
    let fields: ReturnType<typeof formatClassMembers>["fields"];
    beforeAll(() => { fields = formatClassMembers(FIXTURE).fields; });

    it("returns one entry per field", () => {
        expect(fields).toHaveLength(3);
    });

    it("echoes name and descriptor", () => {
        expect(fields[0].name).toBe("random");
        expect(fields[0].descriptor).toBe("Ljava/util/Random;");
    });

    it("resolves access string", () => {
        expect(fields[0].access).toBe("public");
        expect(fields[2].access).toBe("private");
    });

    it("detects isStatic — CONSTANT is static, others are not", () => {
        expect(fields[0].isStatic).toBe(false); // random
        expect(fields[1].isStatic).toBe(true);  // CONSTANT
        expect(fields[2].isStatic).toBe(false); // dimension
    });

    it("detects isFinal — CONSTANT and dimension are final", () => {
        expect(fields[0].isFinal).toBe(false); // random
        expect(fields[1].isFinal).toBe(true);  // CONSTANT
        expect(fields[2].isFinal).toBe(true);  // dimension
    });

    it("shadowAnnotation uses accessStr + static keyword when static", () => {
        expect(fields[1].shadowAnnotation).toBe("@Shadow public static int CONSTANT;");
    });

    it("shadowAnnotation omits 'static' for instance fields", () => {
        expect(fields[0].shadowAnnotation).toBe("@Shadow public Random random;");
    });

    it("uses 'mutable' AT prefix for final fields", () => {
        expect(fields[1].atString).toBe("mutable field net/minecraft/world/World CONSTANT I");
        expect(fields[2].atString).toContain("mutable field net/minecraft/world/World dimension");
    });

    it("uses 'accessible' AT prefix for non-final fields", () => {
        expect(fields[0].atString).toBe(
            "accessible field net/minecraft/world/World random Ljava/util/Random;",
        );
    });
});

describe("formatClassMembers — edge cases", () => {
    it("handles ClassInfo with no methods or fields", () => {
        const empty: ClassInfo = {
            name: "net/minecraft/A",
            superName: "java/lang/Object",
            interfaces: [],
            methods: [],
            fields: [],
        };
        const out = formatClassMembers(empty);
        expect(out.methods).toEqual([]);
        expect(out.fields).toEqual([]);
        expect(out.atStrings.accessible).toBe("accessible class net/minecraft/A");
    });

    it("handles ClassInfo with empty interfaces array", () => {
        const info: ClassInfo = {
            name: "net/minecraft/A",
            superName: "java/lang/Object",
            interfaces: [],
            methods: [],
            fields: [],
        };
        expect(formatClassMembers(info).interfaces).toEqual([]);
    });

    it("is deterministic — same input always returns equal output", () => {
        const a = formatClassMembers(FIXTURE);
        const b = formatClassMembers(FIXTURE);
        expect(a).toEqual(b);
    });
});
