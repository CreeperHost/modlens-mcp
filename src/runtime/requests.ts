import { z } from "zod";
import { RuntimeHub, RUNTIME_HELP } from "./hub.js";
import { runtimeCommand, runtimeMode } from "./protocol.js";

export const runtimeToolSchema = {
    action: z.enum(["help", "setup", "status", "sessions", "launch", "events", "command", "artifact"]),
    projectDir: z
        .string()
        .optional()
        .describe("Absolute local mod project directory for setup; requires an existing Gradle dev run."),
    projectId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    mcVersion: z.literal("26.3").optional(),
    mode: runtimeMode
        .optional()
        .describe("interactive=human input, observe=visible/MCP input only, hidden=invisible/MCP input only"),
    gradleTask: z
        .string()
        .optional()
        .describe("Existing client JavaExec task, defaults to runClient; e.g. :fabric:runClient"),
    minecraftHooks: z
        .boolean()
        .optional()
        .describe(
            "Enable optional 26.3 screenshot/state/crash hooks (default true). SDL input and JVM monitoring are independent.",
        ),
    javaHome: z.string().optional().describe("JDK home for the Gradle launch; use JDK 25 for 26.3"),
    afterCursor: z.number().int().min(0).optional(),
    waitMs: z.number().int().min(0).max(30_000).optional(),
    command: runtimeCommand.optional(),
    artifactName: z.string().optional(),
};
export const runtimeRequest = z.object(runtimeToolSchema);
export type RuntimeRequest = z.infer<typeof runtimeRequest>;
function need<T>(v: T | undefined, name: string): T {
    if (v === undefined) throw new Error(`${name} is required for this action`);
    return v;
}
export async function executeRuntime(hub: RuntimeHub, raw: unknown) {
    const a = runtimeRequest.parse(raw);
    if (a.action === "help") return RUNTIME_HELP;
    switch (a.action) {
        case "setup":
            return hub.setup(need(a.projectDir, "projectDir"), a.mode, a.gradleTask, a.minecraftHooks);
        case "status":
            return hub.status(a.sessionId);
        case "sessions":
            return hub.list();
        case "launch":
            return hub.launch(need(a.projectId, "projectId"), a.javaHome);
        case "events":
            return hub.events(a.afterCursor, a.waitMs, a.sessionId);
        case "command":
            return hub.command(need(a.sessionId, "sessionId"), need(a.command, "command"));
        case "artifact":
            return hub.artifact(need(a.sessionId, "sessionId"), need(a.artifactName, "artifactName"));
    }
}
