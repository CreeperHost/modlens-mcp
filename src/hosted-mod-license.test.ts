import { beforeEach, expect, it, vi } from "vitest";
import { hostedLimits, runHostedTool, type HostedBudget } from "./hosted-policy.js";
import { cachedModLicense } from "./mod-license.js";
import { licenseTemplates } from "./license-templates.js";
import { stageModReference, ingestStagedMod, ModReferenceError } from "./mod-reference.js";

vi.mock("./mod-reference.js", () => ({
    stageModReference: vi.fn(async () => ({ jarPath: "/private/fixture.jar", version: "1.0" })),
    ingestStagedMod: vi.fn(async () => ({ id: 7 })),
    ModReferenceError: class extends Error {},
}));
vi.mock("./mod-license.js", () => ({ cachedModLicense: vi.fn() }));
vi.mock("./tools/project.js", () => ({ projectLicenseArtifact: vi.fn(async () => "/private/project.jar") }));
const budget = { charge: vi.fn(async () => {}) } as unknown as HostedBudget;
const limits = hostedLimits({});
const decision = { sha1: "a".repeat(40), sha256: "b".repeat(64), disposition: "hosted_allowed" as const,
    selectedOrigin: "jar" as const, selectedLicense: "MIT", reason: "fixture", evidence: [],
    notices: [{ name: "LICENSE", licenseText: licenseTemplates.MIT.text }], checkedAt: "fixture" };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(cachedModLicense).mockResolvedValue(decision); });

it("retains complete notices after using the entire source line allowance", async () => {
    const source = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const run = vi.fn(async () => ({ content: [{ type: "text" as const, text: source }] }));
    const result = await runHostedTool("mod", { action: "source", modId: "fixture", path: "example/Fixture.java" }, "user", limits, budget, run);
    expect(result.isError).not.toBe(true);
    expect((result.content[0] as any).text.split("\n")).toHaveLength(200);
    expect(ingestStagedMod).toHaveBeenCalledOnce();
    const last = JSON.parse((result.content.at(-1) as any).text);
    expect(last.licenseCompliance[0].notices).toEqual(decision.notices);
});
it("returns a local consent plan before running any unlicensed source route", async () => {
    vi.mocked(cachedModLicense).mockResolvedValue({ ...decision, disposition: "local_only" });
    for (const [tool, action] of [["mod", "source"], ["mod", "decompile_class"], ["mod", "search_indexed"],
        ["mod", "graph_query"], ["mod_bytecode", "bytecode"], ["project", "source"], ["project", "bytecode"]]) {
        const run = vi.fn();
        const args = { action, modId: "fixture", path: "example/Fixture.java", className: "example.Fixture", query: "method", startLine: 501,
            ...(tool === "project" ? { projectKey: "c".repeat(64), environmentId: "d".repeat(64) } : {}) };
        const result = await runHostedTool(tool, args, "user", limits, budget, run);
        const plan = JSON.parse((result.content[0] as any).text).local;
        expect(plan).toMatchObject({ executed: false, requiresUserConsent: true, request: { localJarPath: "<absolute-path-to-local-mod.jar>", sha256: decision.sha256, acceptedLocalDecompilation: false, startLine: 501 } });
        expect(run).not.toHaveBeenCalled();
        expect(stageModReference).toHaveBeenCalled();
        expect(ingestStagedMod).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain("/private/");
    }
});
it("stages a missing SHA-1 JAR for review and ingests it only after hosted approval", async () => {
    const run = vi.fn(async () => ({ content: [{ type: "text" as const, text: "source" }] }));
    const result = await runHostedTool("mod", { action: "decompile_class", modId: "fixture", sha1: decision.sha1,
        className: "example.Fixture" }, "user", limits, budget, run);
    expect(result.isError).not.toBe(true);
    expect(stageModReference).toHaveBeenCalledWith(expect.objectContaining({ modId: "fixture", sha1: decision.sha1,
        className: "example.Fixture" }));
    expect(cachedModLicense).toHaveBeenCalledWith("/private/fixture.jar", expect.anything());
    expect(ingestStagedMod).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ dbId: 7, modId: 7 }));
});
it("returns an actionable ambiguity without running hosted source", async () => {
    vi.mocked(stageModReference).mockRejectedValueOnce(new ModReferenceError("Ambiguous mod fixture; provide the JAR SHA-1"));
    const run = vi.fn();
    const result = await runHostedTool("mod", { action: "decompile_class", modId: "fixture", className: "example.Fixture" },
        "user", limits, budget, run);
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("provide the JAR SHA-1");
    expect(run).not.toHaveBeenCalled();
});
it("does not execute a global mod source search without an artifact license scope", async () => {
    const run = vi.fn();
    const result = await runHostedTool("mod", { action: "search_source", query: "code" }, "user", limits, budget, run);
    expect(run).not.toHaveBeenCalled();
    expect((result.content[0] as any).text).toContain("license_review_required");
});
it("rejects output if complete mandatory notices cannot fit", async () => {
    vi.mocked(cachedModLicense).mockResolvedValue({ ...decision, notices: [{ name: "NOTICE", licenseText: "x".repeat(limits.responseBytes) }] });
    const result = await runHostedTool("mod", { action: "source", modId: "fixture", path: "Fixture.java" }, "user", limits, budget,
        async () => ({ content: [{ type: "text", text: "SECRET_SOURCE" }] }));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET_SOURCE");
});
it("shares identical bundled licence text while preserving each component and distinct attribution", async () => {
    const notices = Array.from({ length: 50 }, (_, i) => ({ name: `dependency/component-${i}/LICENSE`, licenseText: licenseTemplates["Apache-2.0"].text }));
    notices.push({ name: "dependency/first/NOTICE", licenseText: "First component attribution" },
        { name: "dependency/second/NOTICE", licenseText: "Second component attribution" });
    vi.mocked(cachedModLicense).mockResolvedValue({ ...decision, notices });
    expect(Buffer.byteLength(JSON.stringify(notices))).toBeGreaterThan(limits.responseBytes);
    const result = await runHostedTool("mod", { action: "source", modId: "fixture", path: "Fixture.java" }, "user", limits, budget,
        async () => ({ content: [{ type: "text", text: "class Fixture {}" }] }));
    expect(result.isError).not.toBe(true);
    const attached = JSON.parse((result.content.at(-1) as any).text).licenseCompliance[0].notices;
    expect(attached).toHaveLength(3);
    expect(attached[0].licenseText).toBe(licenseTemplates["Apache-2.0"].text);
    for (const notice of notices) expect(attached.some((n: any) => n.name.split(", ").includes(notice.name) && n.licenseText === notice.licenseText)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(limits.responseBytes);
});
it("keeps metadata-only semantic discovery and signature diffs available", async () => {
    for (const [tool, action] of [["mod", "search_semantic"], ["mod_bytecode", "diff_detailed"]]) {
        const run = vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ className: "example.Fixture" }) }] }));
        const result = await runHostedTool(tool, { action, query: "method", dbIdA: 1, dbIdB: 2 }, "user", limits, budget, run);
        expect(result.isError).not.toBe(true);
        expect(run).toHaveBeenCalledOnce();
    }
    expect(cachedModLicense).not.toHaveBeenCalled();
});
