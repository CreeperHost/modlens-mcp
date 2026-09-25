import { describe, it, expect, beforeAll } from "vitest";
import { parseTinyV2, lookupInIndex, hasSrgMappings, hasRetroMcpMappings, proguardToTiny, composeModernSrgMappings, lookupModernSrgMapping, translateSymbol } from "./mappings.js";

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
        expect(hasSrgMappings("1.6.4")).toBe(true);
        expect(hasSrgMappings("1.7.10")).toBe(true);
        expect(hasSrgMappings("1.8")).toBe(true);
        expect(hasSrgMappings("1.8.9")).toBe(true);
        expect(hasSrgMappings("1.12.2")).toBe(true);
        expect(hasSrgMappings("1.10.2")).toBe(true);
        expect(hasSrgMappings("1.9.2")).toBe(true);
        expect(hasSrgMappings("1.10")).toBe(true);
        expect(hasSrgMappings("1.11.1")).toBe(true);
        expect(hasSrgMappings("1.13")).toBe(true);
        expect(hasSrgMappings("1.14.4")).toBe(true);
        expect(hasSrgMappings("1.15")).toBe(true);
    });

    it("returns false for post-MCP and newer versions", () => {
        expect(hasSrgMappings("1.15.1")).toBe(false);
        expect(hasSrgMappings("1.16.5")).toBe(false);
        expect(hasSrgMappings("1.20.1")).toBe(false);
        expect(hasSrgMappings("26.1.2")).toBe(false);
    });

    it("returns false for versions without SRG", () => {
        expect(hasSrgMappings("1.4.7")).toBe(false);
        expect(hasSrgMappings("1.5.2")).toBe(false);
    });
});

// ── hasRetroMcpMappings ────────────────────────────────────────────────────

describe("hasRetroMcpMappings", () => {
    it("returns true for known RetroMCP release versions", () => {
        expect(hasRetroMcpMappings("1.5.2")).toBe(true);
        expect(hasRetroMcpMappings("1.2.5")).toBe(true);
        expect(hasRetroMcpMappings("1.1")).toBe(true);
        expect(hasRetroMcpMappings("1.0")).toBe(true);
    });

    it("returns true for known RetroMCP beta versions", () => {
        expect(hasRetroMcpMappings("b1.8.1")).toBe(true);
        expect(hasRetroMcpMappings("b1.7.3")).toBe(true);
        expect(hasRetroMcpMappings("b1.6")).toBe(true);
    });

    it("returns true for known RetroMCP alpha versions", () => {
        expect(hasRetroMcpMappings("a1.2.6")).toBe(true);
        expect(hasRetroMcpMappings("a1.0.4")).toBe(true);
    });

    it("returns false for versions without RetroMCP mappings", () => {
        expect(hasRetroMcpMappings("1.7.10")).toBe(false);
        expect(hasRetroMcpMappings("1.6.4")).toBe(false);
        expect(hasRetroMcpMappings("1.20.1")).toBe(false);
        expect(hasRetroMcpMappings("26.1.2")).toBe(false);
    });

    it("does not overlap with SRG versions", () => {
        // No version should be in both sets
        const retroVersions = ["1.5.2", "1.2.5", "1.1", "1.0", "b1.8.1", "a1.2.6"];
        for (const v of retroVersions) {
            expect(hasSrgMappings(v)).toBe(false);
        }
    });
});

describe("Mojang ProGuard to Tiny conversion", () => {
    it("accepts CRLF mappings without retaining carriage returns in names", () => {
        const tiny = proguardToTiny("net.minecraft.world.World -> a:\r\n    int height -> b\r\n");
        const index = parseTinyV2(tiny.replace(/\n/g, "\r\n"));
        expect(index.ns).toEqual(["official", "named"]);
        expect(index.classes.get("a")).toBe("net/minecraft/world/World");
        expect(index.fields.get("a")?.get("b:I")).toBe("height");
    });
    it("maps members with descriptors in the input namespace", () => {
        const result = proguardToTiny(`net.minecraft.Level -> a:\n    net.minecraft.Entity[] entities -> b\n    12:14:net.minecraft.Entity lookup(int,net.minecraft.Entity[]):20:22 -> c\nnet.minecraft.Entity -> d:\n    long id -> a\n`);
        expect(result).toContain("c\ta\tnet/minecraft/Level");
        expect(result).toContain("\tf\t[Ld;\tb\tentities");
        expect(result).toContain("\tm\t(I[Ld;)Ld;\tc\tlookup");
        expect(result).toContain("\tf\tJ\ta\tid");
    });
    it("deduplicates line mappings and excludes foreign inline owners", () => {
        const result = proguardToTiny(`Example -> a:\n    1:2:void run():4:5 -> b\n    3:4:void run():6:7 -> b\n    5:6:void Other.inline():1:2 -> b\n`);
        expect(result.match(/\tm\t/g)).toHaveLength(1);
        expect(result).toContain("\tm\t()V\tb\trun");
    });
});

describe("modern Forge SRG to Mojmap members", () => {
    const tsrg = `tsrg2 obf srg id\na net/minecraft/src/C_507_ 507\n\ta ()Ld; m_20183_ 20183\nb net/minecraft/src/C_2752_ 2752\n\tc f_77313_ 77313\nd net/minecraft/src/C_4675_ 4675\ne net/minecraft/src/C_526_ 526\nf net/minecraft/src/C_2756_ 2756\n\tg (I)Z m_8086_ 8086\n`;
    const proguard = `net.minecraft.world.entity.Entity -> a:\n    net.minecraft.core.BlockPos blockPosition() -> a\nnet.minecraft.world.level.pathfinder.NodeEvaluator -> b:\n    net.minecraft.world.entity.Mob mob -> c\nnet.minecraft.core.BlockPos -> d:\nnet.minecraft.world.entity.Mob -> e:\nnet.minecraft.world.level.pathfinder.FlyNodeEvaluator -> f:\n    boolean getBlockPathType(int) -> g\n`;
    const mappings = composeModernSrgMappings("1.20.1", tsrg, { server: proguard });

    it("resolves a method through an inherited receiver with declaring owner and descriptor", () => {
        expect(lookupModernSrgMapping(mappings, "Mob.m_20183_()")).toMatchObject({
            found: true, target: "blockPosition", type: "method", verified: true,
            containingClass: "net/minecraft/world/entity/Entity", requestedOwner: "Mob", descriptor: "()Lnet/minecraft/core/BlockPos;", mcVersion: "1.20.1",
            mappingSources: ["MCPConfig joined.tsrg", "Mojang server_mappings"],
        });
    });

    it("resolves a field and a qualified stack-frame method", () => {
        expect(lookupModernSrgMapping(mappings, "f_77313_")).toMatchObject({
            found: true, target: "mob", type: "field", containingClass: "net/minecraft/world/level/pathfinder/NodeEvaluator", descriptor: "Lnet/minecraft/world/entity/Mob;",
        });
        expect(lookupModernSrgMapping(mappings, "net.minecraft.world.level.pathfinder.FlyNodeEvaluator.m_8086_")).toMatchObject({
            found: true, target: "getBlockPathType", type: "method", containingClass: "net/minecraft/world/level/pathfinder/FlyNodeEvaluator", descriptor: "(I)Z",
        });
    });

    it("does not guess when a member has multiple owners or signatures", () => {
        const ambiguous = composeModernSrgMappings("1.20.1", `tsrg2 obf srg id\na net/minecraft/src/C_1_ 1\n\tx (I)V m_123_ 123\nb net/minecraft/src/C_2_ 2\n\ty ()V m_123_ 123\n`, {
            server: `net.minecraft.A -> a:\n    void first(int) -> x\nnet.minecraft.B -> b:\n    void second() -> y\n`,
        });
        expect(lookupModernSrgMapping(ambiguous, "m_123_")).toMatchObject({ found: false, note: expect.stringContaining("Ambiguous") });
        expect(lookupModernSrgMapping(ambiguous, "B.m_123_()")).toMatchObject({ found: true, target: "second" });
        expect(lookupModernSrgMapping(ambiguous, "A.m_123_()")).toMatchObject({ found: false });
        expect(lookupModernSrgMapping(ambiguous, "f_999_")).toMatchObject({ found: false });
    });

    it("keeps multiple possible declaring owners while returning a common verified name", () => {
        const duplicated = composeModernSrgMappings("1.20.1", `tsrg2 obf srg id\na net/minecraft/src/C_1_ 1\n\tx ()V m_123_ 123\nb net/minecraft/src/C_2_ 2\n\ty ()V m_123_ 123\n`, {
            server: `net.minecraft.A -> a:\n    void common() -> x\nnet.minecraft.B -> b:\n    void common() -> y\n`,
        });
        expect(lookupModernSrgMapping(duplicated, "Mob.m_123_()")).toMatchObject({
            found: true, target: "common", candidateOwners: ["net/minecraft/A", "net/minecraft/B"], requestedOwner: "Mob", descriptor: "()V",
        });
    });

    it("reports unsupported versions without fetching unrelated mappings", async () => {
        expect(await translateSymbol("Mob.m_20183_()", "srg", "mojmap", "1.15.2")).toMatchObject({
            found: false, note: expect.stringContaining("unsupported"),
        });
    });
});
