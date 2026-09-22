import { describe, expect, it } from "vitest";
import { reportIssue } from "./report-issue.js";
import { hostedLimits, prepareHostedArgs } from "../hosted-policy.js";

describe("report_issue", () => {
    it("offers guidance without inventing a report or claiming submission", () => {
        const result = reportIssue({ action: "help" }, "1.2.3");
        expect(result).toMatchObject({ state: "guidance", executed: false });
        expect(result).not.toHaveProperty("draft");
        expect(result.repository.url).toBe("https://github.com/CreeperHost/modlens-mcp");
        expect(result.workflow.join(" ")).toContain("search open and closed issues");
        expect(result.workflow.join(" ")).toContain("do not ask again");
    });

    it("prepares an actionable report and distinguishes server from client environment", () => {
        const result = reportIssue({
            action: "prepare", title: "Hidden client stops accepting input",
            summary: "Input stops after reconnecting the helper.", component: "runtime",
            steps: ["Start the hidden client", "Restart the helper", "Send W"],
            expected: "The client moves", actual: "The command times out",
            environment: { minecraft: "26.3", java: "25", os: "Windows", connection: "remote", localHelperVersion: "1.2.2" },
            diagnostics: "Timeout waiting for input",
        }, "1.2.3");
        expect(result.state).toBe("draft_prepared");
        if (!("draft" in result)) throw new Error("Missing draft");
        expect(result.executed).toBe(false);
        expect(result.draft.body).toContain("3. Send W");
        expect(result.draft.body).toContain("ModLens MCP server: 1.2.3");
        expect(result.draft.body).toContain("localHelperVersion: 1.2.2");
        expect(result.missingDetails).toEqual([]);
        expect(result.github).toMatchObject({ owner: "CreeperHost", repo: "modlens-mcp" });
    });

    it("leaves unknown facts explicit and keeps shell metacharacters as argument data", () => {
        const title = 'Failure with $(touch nope) and `quotes`';
        const result = reportIssue({ action: "prepare", title, summary: "Observed a failure", diagnostics: "before\n```\nafter" }, "1.2.3");
        if (!("draft" in result)) throw new Error("Missing draft");
        expect(result.draft.body).toContain("Not provided.");
        expect(result.missingDetails).toContain("client environment");
        expect(result.cli.arguments).toContain(title);
        expect(result.cli.arguments).toContain("--body-file");
        expect(result.cli.arguments).not.toContain(result.draft.body);
        expect(result.draft.body).toContain("````text\nbefore\n```\nafter\n````");
    });

    it("requires a useful minimum and bounds diagnostics", () => {
        expect(() => reportIssue({ action: "prepare", title: "Failure" }, "1")).toThrow("summary");
        expect(() => reportIssue({ action: "prepare", title: " ", summary: "Failure" }, "1")).toThrow();
        expect(() => reportIssue({ action: "prepare", title: "Failure", summary: "Details", diagnostics: "x".repeat(4001) }, "1")).toThrow();
        expect(() => reportIssue({ action: "create", title: "Failure", summary: "Details" }, "1")).toThrow();
    });

    it("allows remote draft preparation but exposes no publish action", () => {
        const request = { action: "prepare", title: "Failure", summary: "Details" };
        expect(prepareHostedArgs("report_issue", request, hostedLimits({}))).toEqual(request);
        expect(() => prepareHostedArgs("report_issue", { action: "create" }, hostedLimits({}))).toThrow();
    });
});
