import { describe, it, expect } from "vitest";
import { mcVersionWhere } from "./mod.js";

/** Pull the `startsWith` family-prefix out of the generated filter. */
function familyPrefix(mcVersion: string): string {
    const filter = mcVersionWhere(mcVersion);
    const arm = (filter.OR as Array<{ mcVersion: { startsWith: string } }>)[1];
    return arm.mcVersion.startsWith;
}

describe("mcVersionWhere", () => {
    it("matches the exact MC version", () => {
        expect(mcVersionWhere("1.21.1")).toEqual({
            OR: [{ mcVersion: "1.21.1" }, { mcVersion: { startsWith: "1.21.1." } }],
        });
    });

    it("does not let 1.21.1 pull in 1.21.11 (different patch versions are not compatible)", () => {
        const prefix = familyPrefix("1.21.1"); // "1.21.1."
        expect("1.21.11".startsWith(prefix)).toBe(false);
        expect("1.21.1.0".startsWith(prefix)).toBe(true); // a real sub-version still matches
    });

    it("treats a partial version as a family prefix (1.21 → all 1.21.x)", () => {
        const prefix = familyPrefix("1.21"); // "1.21."
        expect("1.21.1".startsWith(prefix)).toBe(true);
        expect("1.21.11".startsWith(prefix)).toBe(true);
        expect("1.211".startsWith(prefix)).toBe(false); // not a 1.21 patch
    });
});
