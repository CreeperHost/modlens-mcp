import { describe, it, expect } from "vitest";
import { searchClasses } from "./search.js";

const CLASSES = [
    "net/minecraft/world/entity/LivingEntity",
    "net/minecraft/world/entity/player/Player",
    "net/minecraft/world/level/block/Block",
    "net/minecraft/world/level/block/entity/BlockEntity",
    "net/minecraft/world/item/Item",
    "net/minecraft/world/item/ItemStack",
    "com/example/mod/EnergyStorage",
    "com/example/mod/EnergyStorageBlockEntity",
    "com/example/mod/ExampleMod",
    "com/example/mod/integration/jei/JEIPlugin",
];

describe("searchClasses", () => {
    it("returns empty array for empty query", () => {
        expect(searchClasses(CLASSES, "")).toHaveLength(0);
        expect(searchClasses(CLASSES, "   ")).toHaveLength(0);
    });

    it("exact simple name match ranks first", () => {
        const results = searchClasses(CLASSES, "Block");
        expect(results[0]).toBe("net/minecraft/world/level/block/Block");
    });

    it("prefix match ranks before substring match", () => {
        const results = searchClasses(CLASSES, "Item");
        // "Item" exact match before "ItemStack" prefix match
        expect(results[0]).toBe("net/minecraft/world/item/Item");
        expect(results[1]).toBe("net/minecraft/world/item/ItemStack");
    });

    it("CamelCase acronym match works", () => {
        const results = searchClasses(CLASSES, "LE");
        expect(results).toContain("net/minecraft/world/entity/LivingEntity");
    });

    it("CamelCase acronym is case-insensitive", () => {
        const results = searchClasses(CLASSES, "le");
        expect(results).toContain("net/minecraft/world/entity/LivingEntity");
    });

    it("case-insensitive prefix match works", () => {
        const results = searchClasses(CLASSES, "block");
        expect(results).toContain("net/minecraft/world/level/block/Block");
        expect(results).toContain("net/minecraft/world/level/block/entity/BlockEntity");
    });

    it("substring match works", () => {
        const results = searchClasses(CLASSES, "Storage");
        expect(results).toContain("com/example/mod/EnergyStorage");
        expect(results).toContain("com/example/mod/EnergyStorageBlockEntity");
    });

    it("substring match on full internal path works", () => {
        const results = searchClasses(CLASSES, "jei");
        expect(results).toContain("com/example/mod/integration/jei/JEIPlugin");
    });

    it("returns at most 100 results", () => {
        const many = Array.from({ length: 200 }, (_, i) => `com/example/Foo${i}`);
        const results = searchClasses(many, "Foo");
        expect(results.length).toBeLessThanOrEqual(100);
    });

    it("returns empty array when nothing matches", () => {
        expect(searchClasses(CLASSES, "Zzzzz")).toHaveLength(0);
    });

    it("results are sorted — lower score before higher score", () => {
        // "ES" is a CamelCase match for EnergyStorage — should appear before a pure substring match
        const results = searchClasses(CLASSES, "ES");
        const esIdx = results.findIndex(r => r.includes("EnergyStorage"));
        const exIdx = results.findIndex(r => r.includes("ExampleMod"));
        // EnergyStorage "ES" acronym should rank before ExampleMod "EM" — which shouldn't match at all
        expect(esIdx).toBeGreaterThanOrEqual(0);
        if (exIdx !== -1) expect(esIdx).toBeLessThan(exIdx);
    });
});
