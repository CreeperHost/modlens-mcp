import { describe, expect, it } from "vitest";
import { resolveForgeArtifactVersions } from "./platform.js";

describe("resolveForgeArtifactVersions", () => {
    it("tries legacy Forge coordinates with the trailing MC version suffix", () => {
        expect(resolveForgeArtifactVersions("10.13.4.1614", "1.7.10")).toEqual([
            "1.7.10-10.13.4.1614",
            "1.7.10-10.13.4.1614-1.7.10",
        ]);
    });

    it("does not duplicate a full legacy coordinate that already has the suffix", () => {
        expect(resolveForgeArtifactVersions("1.7.10-10.13.4.1614-1.7.10", "1.7.10")).toEqual([
            "1.7.10-10.13.4.1614-1.7.10",
        ]);
    });
});
