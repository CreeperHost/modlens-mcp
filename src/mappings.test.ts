import { describe, it, expect, beforeAll } from "vitest";
import { parseTinyV2, lookupInIndex, hasSrgMappings } from "./mappings.js";

const FIXTURE_TINY = [
    "tiny\t2\t0\tofficial\tintermediary",
    "c\tnet/minecraft/world/World\tnet/minecraft/class_234",
    "\tf\tI\tfield_1234\tfield_1234_",
    "\tm\t()V\tmethod_1234\tmethod_1234_",
    "c\tnet/minecraft/entity/Entity\tnet/minecraft/class_100",
    "\tm\t(Ljava/lang/String;)Z\tmethod_5678\tmethod_5678_",
].join("\n");

// ── parseTinyV2 ────────────────────────────────────────────────────────────

describe("parseTinyV2", () => {
    it("reads namespace headers from first line", () => {
        const idx = parseTinyV2(FIXTURE_TINY);
        expect(idx.ns[0]).toBe("official");
        expect(idx.ns[1]).toBe("intermediary");
    });

    it("maps official class name to intermediary name", () => {
        const idx = parseTinyV2(FIXTURE_TINY);
        expect(idx.classes.get("net/minecraft/world/World")).toBe("net/minecraft/class_234");
        expect(idx.classes.get("net/minecraft/entity/Entity")).toBe("net/minecraft/class_100");
    });

    it("maps method key 'name+descriptor' within the correct class", () => {
        const idx = parseTinyV2(FIXTURE_TINY);
        const worldMethods = idx.methods.get("net/minecraft/world/World");
        expect(worldMethods).toBeDefined();
        expect(worldMethods!.get("method_1234()V")).toBe("method_1234_");
    });

    it("maps field key 'name:descriptor' within the correct class", () => {
        const idx = parseTinyV2(FIXTURE_TINY);
        const worldFields = idx.fields.get("net/minecraft/world/World");
        expect(worldFields).toBeDefined();
        expect(worldFields!.get("field_1234:I")).toBe("field_1234_");
    });

    it("handles class with no fields or methods", () => {
        const tiny = "tiny\t2\t0\tofficial\tintermediary\nc\tnet/minecraft/A\tnet/minecraft/class_1";
        const idx = parseTinyV2(tiny);
        expect(idx.classes.get("net/minecraft/A")).toBe("net/minecraft/class_1");
        expect(idx.methods.get("net/minecraft/A")).toBeDefined();
        expect(idx.methods.get("net/minecraft/A")!.size).toBe(0);
    });

    it("ignores comment lines starting with #", () => {
        const tiny = [
            "tiny\t2\t0\tofficial\tintermediary",
            "# this is a comment",
            "c\tnet/minecraft/A\tnet/minecraft/class_1",
        ].join("\n");
        const idx = parseTinyV2(tiny);
        expect(idx.classes.size).toBe(1);
    });
});

// ── lookupInIndex — forward ────────────────────────────────────────────────

describe("lookupInIndex — forward (official → intermediary)", () => {
    let idx: ReturnType<typeof parseTinyV2>;
    beforeAll(() => { idx = parseTinyV2(FIXTURE_TINY); });

    it("finds a class by official name", () => {
        const r = lookupInIndex(idx, "net/minecraft/world/World", false);
        expect(r.found).toBe(true);
        expect(r.target).toBe("net/minecraft/class_234");
        expect(r.type).toBe("class");
    });

    it("finds a method by name only (no descriptor)", () => {
        const r = lookupInIndex(idx, "method_1234", false);
        expect(r.found).toBe(true);
        expect(r.target).toBe("method_1234_");
        expect(r.type).toBe("method");
    });

    it("finds a field by name", () => {
        const r = lookupInIndex(idx, "field_1234", false);
        expect(r.found).toBe(true);
        expect(r.target).toBe("field_1234_");
        expect(r.type).toBe("field");
    });

    it("returns found=false for unknown symbol", () => {
        const r = lookupInIndex(idx, "nonexistent_method", false);
        expect(r.found).toBe(false);
    });
});

// ── lookupInIndex — reverse ────────────────────────────────────────────────

describe("lookupInIndex — reverse (intermediary → official)", () => {
    let idx: ReturnType<typeof parseTinyV2>;
    beforeAll(() => { idx = parseTinyV2(FIXTURE_TINY); });

    it("reverse-finds a class by intermediary name", () => {
        const r = lookupInIndex(idx, "net/minecraft/class_234", true);
        expect(r.found).toBe(true);
        expect(r.target).toBe("net/minecraft/world/World");
        expect(r.type).toBe("class");
    });

    it("reverse-finds a method by intermediary name", () => {
        const r = lookupInIndex(idx, "method_1234_", true);
        expect(r.found).toBe(true);
        expect(r.type).toBe("method");
    });

    it("reverse-finds a field by intermediary name", () => {
        const r = lookupInIndex(idx, "field_1234_", true);
        expect(r.found).toBe(true);
        expect(r.type).toBe("field");
    });

    it("returns found=false for unknown reverse symbol", () => {
        const r = lookupInIndex(idx, "class_9999_unknown", true);
        expect(r.found).toBe(false);
    });
});

// ── hasSrgMappings ─────────────────────────────────────────────────────────

describe("hasSrgMappings", () => {
    it("returns true for known SRG versions", () => {
        expect(hasSrgMappings("1.7.10")).toBe(true);
        expect(hasSrgMappings("1.8")).toBe(true);
        expect(hasSrgMappings("1.8.9")).toBe(true);
        expect(hasSrgMappings("1.12.2")).toBe(true);
        expect(hasSrgMappings("1.10.2")).toBe(true);
    });

    it("returns false for mojmap-era and newer versions", () => {
        expect(hasSrgMappings("1.14")).toBe(false);
        expect(hasSrgMappings("1.16.5")).toBe(false);
        expect(hasSrgMappings("1.20.1")).toBe(false);
        expect(hasSrgMappings("26.1.2")).toBe(false);
    });

    it("returns false for versions without SRG", () => {
        expect(hasSrgMappings("1.6.4")).toBe(false);
        expect(hasSrgMappings("1.13")).toBe(false);
    });
});
