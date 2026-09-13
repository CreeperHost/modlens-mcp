import { describe, it, expect } from "vitest";
import { matchesVersionRange, normalizeVersionRange } from "./version-ranges.js";
describe("Minecraft dependency declarations", () => {
    it.each([
        ["b1.7.3", "b1.7.3", true], ["b1.7.2", "b1.7.3", false],
        ["1.2.5", "[1.2.5]", true], ["1.3.1", "[1.2.5]", false],
        ["1.6.4", "[1.6.2,1.7)", true], ["1.7.2", "[1.6.2,1.7)", false],
        ["1.7.10", "[1.7.10,1.8)", true], ["1.7.2", "[1.7.10,1.8)", false],
        ["1.8.9", "(,1.8],[1.8.9,)", true], ["1.8.8", "(,1.8],[1.8.9,)", false],
        ["1.12.2", "[1.12,1.13)", true], ["1.13.2", "[1.12,1.13)", false],
        ["1.16.5", ">=1.16.2 <1.17", true], ["1.17", ">=1.16.2 <1.17", false],
        ["1.18.2", "~1.18.1", true], ["1.19", "~1.18.1", false],
        ["1.21.1", "[1.21.1,)", true], ["1.21", "[1.21.1,)", false],
        ["1.22", "[1.21,1.22)", false], ["1.21.1", ">=1.21 <1.22", true],
        ["1.22", ">=1.21 <1.22", false], ["1.21.1", "~1.21", true],
        ["1.22", "~1.21", false], ["0.4", "^0.3", true],
        ["1.21.4", "1.21.x", true], ["1.211", "1.21.x", false],
        ["1.21.1-rc.1", ">=1.21.1- <1.21.1", true],
        ["1.21.1", "[1.21.1]", true], ["1.22", "[1.21.1]", false],
        ["26.1.2", ["~1.21.1", "26.1.2"], true],
    ])("%s against %s", (version, range, expected) => {
        expect(matchesVersionRange(version as string, range)).toBe(expected);
    });
    it("normalizes Fabric arrays to OR without passing arrays to Prisma", () => {
        expect(normalizeVersionRange(["1.21.1", "1.21.2"])).toBe("1.21.1 || 1.21.2");
    });
});
