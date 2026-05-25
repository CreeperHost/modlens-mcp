import { describe, it, expect } from "vitest";
import { validateDbId, validateVersion, validateClassName } from "./validate.js";

describe("validateDbId", () => {
    it("accepts a valid positive integer", () => {
        expect(() => validateDbId(1)).not.toThrow();
        expect(() => validateDbId(999999)).not.toThrow();
    });

    it("throws for zero", () => {
        expect(() => validateDbId(0)).toThrow("dbId");
    });

    it("throws for negative", () => {
        expect(() => validateDbId(-1)).toThrow("dbId");
    });

    it("throws for non-integer (float)", () => {
        expect(() => validateDbId(1.5)).toThrow("dbId");
    });

    it("throws for NaN", () => {
        expect(() => validateDbId(NaN)).toThrow("dbId");
    });

    it("returns the id on success", () => {
        expect(validateDbId(42)).toBe(42);
    });
});

describe("validateVersion", () => {
    it("accepts a normal MC version string", () => {
        expect(() => validateVersion("1.21.1")).not.toThrow();
        expect(() => validateVersion("26.1.2")).not.toThrow();
    });

    it("throws for empty string", () => {
        expect(() => validateVersion("")).toThrow("version");
    });

    it("throws for excessively long string", () => {
        expect(() => validateVersion("a".repeat(65))).toThrow("version");
    });

    it("throws for strings with shell metacharacters", () => {
        expect(() => validateVersion("1.21; rm -rf /")).toThrow("version");
        expect(() => validateVersion("1.21 && echo hi")).toThrow("version");
        expect(() => validateVersion("1.21`id`")).toThrow("version");
    });

    it("returns the version string on success", () => {
        expect(validateVersion("1.21.1")).toBe("1.21.1");
    });
});

describe("validateClassName", () => {
    it("accepts valid Java binary class names", () => {
        expect(() => validateClassName("net/minecraft/world/World")).not.toThrow();
        expect(() => validateClassName("com/example/MyMod")).not.toThrow();
    });

    it("accepts dot-separated names too", () => {
        expect(() => validateClassName("net.minecraft.world.World")).not.toThrow();
    });

    it("accepts Java inner class names with $", () => {
        expect(() => validateClassName("net/minecraft/client/gui/components/Button$Builder")).not.toThrow();
        expect(() => validateClassName("net.minecraft.client.gui.components.Button$Builder")).not.toThrow();
        expect(() => validateClassName("com/example/Outer$Inner$Deeper")).not.toThrow();
    });

    it("throws for empty string", () => {
        expect(() => validateClassName("")).toThrow("className");
    });

    it("throws for strings with path traversal sequences", () => {
        expect(() => validateClassName("../evil/Class")).toThrow("className");
    });

    it("throws for strings with shell metacharacters", () => {
        expect(() => validateClassName("net/mc/World; rm -rf /")).toThrow("className");
    });

    it("throws for excessively long class name", () => {
        expect(() => validateClassName("a/".repeat(101))).toThrow("className");
    });

    it("returns the class name on success", () => {
        expect(validateClassName("net/minecraft/world/World")).toBe("net/minecraft/world/World");
    });
});
