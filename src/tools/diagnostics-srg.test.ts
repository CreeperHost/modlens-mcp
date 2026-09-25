import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeCrashLog } from "./diagnostics.js";
import { translateSymbol } from "../mappings.js";
import { findModClassesByClassNames } from "../repositories/mod.js";
import { searchMods, getModsBatch } from "../modpacks-ch.js";

vi.mock("../mappings.js", () => ({ translateSymbol: vi.fn() }));
vi.mock("../repositories/mod.js", () => ({ findModClassesByClassNames: vi.fn(), listAllMods: vi.fn() }));
vi.mock("../modpacks-ch.js", () => ({ searchMods: vi.fn(), getModsBatch: vi.fn() }));
vi.mock("./modpacks-ch.js", () => ({ downloadModAction: vi.fn() }));

describe("SRG names in crash analysis", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(findModClassesByClassNames).mockResolvedValue([]);
        vi.mocked(searchMods).mockResolvedValue(null as any);
        vi.mocked(getModsBatch).mockResolvedValue([] as any);
        vi.mocked(translateSymbol).mockImplementation(async (symbol, from, to, version) => {
            if (from === "srg" && to === "mojmap" && version === "1.20.1") {
                const known: Record<string, { target: string; type: "method" | "field"; containingClass: string; descriptor: string }> = {
                    "net.minecraft.world.entity.Mob.m_20183_()": { target: "blockPosition", type: "method", containingClass: "net/minecraft/world/entity/Entity", descriptor: "()Lnet/minecraft/core/BlockPos;" },
                    "f_77313_": { target: "mob", type: "field", containingClass: "net/minecraft/world/level/pathfinder/NodeEvaluator", descriptor: "Lnet/minecraft/world/entity/Mob;" },
                    "net/minecraft/world/level/pathfinder/FlyNodeEvaluator.m_8086_": { target: "getBlockPathType", type: "method", containingClass: "net/minecraft/world/level/pathfinder/FlyNodeEvaluator", descriptor: "(Lnet/minecraft/world/level/BlockGetter;III)Lnet/minecraft/world/level/pathfinder/BlockPathTypes;" },
                };
                const member = known[symbol];
                if (member) return { found: true, source: symbol, mcVersion: version, verified: true, mappingSources: ["MCPConfig joined.tsrg", "Mojang server_mappings"], ...member };
            }
            return { found: false, source: symbol, type: "unknown" as const, note: "No verified mapping" };
        });
    });

    it("exposes verified NPE and frame names with owner context without asserting a cause", async () => {
        const log = `---- Minecraft Crash Report ----\nMinecraft Version: 1.20.1\nForge Version: 47.4.10\njava.lang.NullPointerException: Cannot invoke "net.minecraft.world.entity.Mob.m_20183_()" because "this.f_77313_" is null\n\tat net.minecraft.world.level.pathfinder.FlyNodeEvaluator.m_8086_(FlyNodeEvaluator.java:306) ~[server-1.20.1-srg.jar]\n\tat com.github.teamfossilsarcheology.fossil.entity.ai.DinoFollowOwnerGoal.canTeleportTo(DinoFollowOwnerGoal.java:132) ~[fossil-forge.jar]\n`;
        const result = await analyzeCrashLog(log) as any;
        expect(result.crashFacts.mappedException).toContain("Mob.blockPosition()");
        expect(result.crashFacts.mappedException).toContain("this.mob");
        expect(result.crashFacts.mappedMembers).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: "net.minecraft.world.entity.Mob.m_20183_()", target: "blockPosition", verified: true, containingClass: "net/minecraft/world/entity/Entity" }),
            expect.objectContaining({ source: "this.f_77313_", target: "mob", verified: true, contextClass: "net/minecraft/world/level/pathfinder/FlyNodeEvaluator" }),
        ]));
        expect(result.frames[0].mappedMethod).toBe("getBlockPathType");
        expect(result.frames[0].methodMapping).toMatchObject({ verified: true, descriptor: expect.stringContaining("BlockGetter") });
        expect(result.frames[1].method).toBe("canTeleportTo");
        expect(result.memberMappingNote).toContain("do not establish the cause");
    });
});
