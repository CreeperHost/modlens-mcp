import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pending: true, indexed: false, decompiles: 0, indexes: 0 }));
vi.mock("../minecraft.js", () => ({ mcPaths: { decompiled: (version: string) => version } }));
vi.mock("../mappings.js", () => ({ hasSrgMappings: () => false }));
vi.mock("../java-tools.js", () => ({ isDecompileDone: async () => "done" }));
vi.mock("./mc-fts.js", () => ({
    isMcVersionIndexed: async () => state.indexed,
    indexMcVersion: async () => { state.indexes++; state.indexed = true; return { status: "done", indexed: 1, skipped: 0 }; },
}));
vi.mock("./vanilla.js", () => ({
    hasPendingMinecraftClassPreparation: () => state.pending,
    decompileMcVersion: async () => { state.decompiles++; return { status: "already_done" }; },
    ensureMcSourceNames: async () => {},
}));

import { scheduleHostedMinecraftVersionIndex } from "./hosted-mc-index.js";

it("prioritizes requested classes and deduplicates a full-version build", async () => {
    scheduleHostedMinecraftVersionIndex("1.21.1");
    scheduleHostedMinecraftVersionIndex("1.21.1");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(state.decompiles).toBe(0);
    state.pending = false;
    for (let attempt = 0; attempt < 20 && !state.indexed; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(state.decompiles).toBe(1);
    expect(state.indexes).toBe(1);
    scheduleHostedMinecraftVersionIndex("1.21.1");
    expect(state.decompiles).toBe(1);
});
