import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { stageModReference, ingestStagedMod, type StagedMod } from "./mod-reference.js";
import { cachedModLicense, type LicenseDecision } from "./mod-license.js";
import { projectLicenseArtifact } from "./tools/project.js";
import { compactNotices } from "./license-notices.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export function localModPlan(decision: LicenseDecision, args: Record<string, unknown>, accepted = false) {
    const className = typeof args.className === "string" ? args.className : typeof args.path === "string" ? args.path.replace(/\.java$/, "") : "<class-name>";
    return {
        execution: "local_helper_required", executed: false, requiresUserConsent: !accepted,
        reason: decision.reason, sha256: decision.sha256, selectedOrigin: decision.selectedOrigin,
        steps: [
            "Explain the license decision and obtain the user's explicit acceptance of local decompilation for this exact artifact. Never infer acceptance from requesting hosted source.",
            "Locate this JAR on the user's computer (for example their mods directory or Gradle cache). The helper verifies the SHA-256. Do not use a path on the hosted server.",
            "Write the request below as a UTF-8 JSON file locally. Replace the local JAR path and class name as needed. Set acceptedLocalDecompilation only after user acceptance; otherwise the helper prompts in an interactive terminal.",
            "Execute the helper with the local terminal tool and read its JSON result. It provisions the existing Java/decompiler tooling as needed. No hosted upload or second MCP connection is required.",
        ],
        invocation: { executable: "npx", arguments: ["-y", `@creeperhost/modlens-mcp@${pkg.version}`, "--local-mod", "--request-file", "<local-request.json>"] },
        sourceCheckout: { executable: "node", arguments: ["<local-modlens-checkout>/dist/launcher.js", "--local-mod", "--request-file", "<local-request.json>"] },
        request: { localJarPath: "<absolute-path-to-local-mod.jar>", sha256: decision.sha256, className,
            operation: args.action === "bytecode" ? "bytecode" : "source", acceptedLocalDecompilation: accepted,
            startLine: args.startLine ?? 1, maxLines: args.maxLines ?? 200 },
        notice: "Local acceptance is not permission from the copyright holder and does not authorize hosted redistribution. Keep restricted output local.",
    };
}

export async function reviewHostedMod(args: Record<string, unknown>): Promise<LicenseDecision> {
    if (args.projectKey !== undefined) {
        const artifact = await projectLicenseArtifact(String(args.projectKey), String(args.environmentId ?? ""), String(args.className ?? ""));
        return cachedModLicense(artifact);
    }
    const ref = args.dbId ?? args.modId;
    if (typeof ref !== "string" && typeof ref !== "number") throw new Error("Specify modId/dbId, or a project class, to inspect its license.");
    const staged = await stageModReference({ modId: args.modId as string | number | undefined,
        dbId: args.dbId as number | undefined, sha1: args.sha1 as string | undefined,
        mcVersion: args.mcVersion as string | undefined, modVersion: args.modVersion as string | undefined,
        loader: args.loader as string | undefined,
        className: args.className as string | undefined });
    return reviewStagedMod(staged);
}

async function reviewStagedMod(staged: StagedMod): Promise<LicenseDecision> {
    const metadata = staged.mod?.metadata as Record<string, unknown> | null | undefined;
    return cachedModLicense(staged.jarPath, { version: staged.version,
        sourceUrl: typeof metadata?.sourceUrl === "string" ? metadata.sourceUrl : staged.sourceUrl });
}

export async function guardHostedMod(tool: string, args: Record<string, unknown>): Promise<{ blocked?: CallToolResult; notices?: LicenseDecision[] }> {
    const action = String(args.action);
    const modSource = tool === "mod" && ["source", "decompile_class", "search_source", "search_indexed", "graph_query", "graph_report"].includes(action);
    const bytecode = tool === "mod_bytecode" && action === "bytecode";
    const project = tool === "project" && ["source", "bytecode"].includes(action);
    if (!modSource && !bytecode && !project) return {};
    if (!project && args.modId === undefined && args.dbId === undefined && args.dbIdA === undefined) return { blocked: out({ execution: "license_review_required", executed: false,
        reason: "Specify modId/dbId for hosted source search so the correct artifact license can be checked. Metadata/class searches remain available." }) };
    const staged = project ? undefined : await stageModReference({ modId: args.modId as string | number | undefined,
        dbId: args.dbId as number | undefined, sha1: args.sha1 as string | undefined,
        mcVersion: args.mcVersion as string | undefined, modVersion: args.modVersion as string | undefined,
        loader: args.loader as string | undefined,
        className: args.className as string | undefined });
    const decision = staged ? await reviewStagedMod(staged) : await reviewHostedMod(args);
    if (decision.disposition !== "hosted_allowed") return { blocked: out({ licenseReview: decision, local: localModPlan(decision, args) }) };
    if (staged) {
        const mod = await ingestStagedMod(staged);
        args.dbId = mod.id;
        args.modId = mod.id;
    }
    return { notices: [decision] };
}

export function attachLicenseNotices(result: CallToolResult, decisions: LicenseDecision[]): CallToolResult {
    if (result.isError || !decisions.length) return result;
    return { ...result, content: [...result.content, { type: "text", text: JSON.stringify({ licenseCompliance: decisions.map(d => ({
        sha256: d.sha256, license: d.selectedLicense, origin: d.selectedOrigin, notices: compactNotices(d.notices), conditions: d.conditions,
        sourceUrl: d.sourceUrl, modifiedAt: new Date().toISOString(),
        notice: `ModLens reconstructed or excerpted this output. Any ModLens contributions to this output are offered under ${d.selectedLicense}. Retain these notices with copies. No warranty is provided. This licence applies to the mod output, not unrelated Minecraft code or ModLens itself.`,
    })) }) }] };
}
