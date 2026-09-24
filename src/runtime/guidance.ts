import { readFileSync } from "node:fs";
import type { RuntimeRequest } from "./requests.js";

const version = (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export function localExecutionPlan(request: RuntimeRequest) {
    return {
        execution: "local_helper_required",
        executed: false,
        helperVersion: version,
        message:
            "Run this workflow using your LOCAL terminal/file tools on the computer running Minecraft. This remote MCP response has not configured, launched, or controlled a JVM.",
        steps: [
            "Write request below as UTF-8 JSON to a temporary local file, e.g. runtime-request.json. Use paths on the user's PC, not paths on the remote MCP server.",
            "Invoke the helper with the executable and separate arguments below; substitute the request file's path. Follow the local host's normal execution permissions. Do not paste JSON or project paths into an unquoted shell command.",
            "Read the helper's JSON result. Setup creates ModLens Client in IntelliJ; launch starts the chosen Gradle task. Reuse this helper for sessions/status/events/command/artifact requests.",
            "For a screenshot, request command screenshot, then artifact using the returned name, then view the returned local image path with your image tool. Use events with afterCursor and waitMs up to 30000 while monitoring.",
        ],
        invocation: {
            executable: "npx",
            arguments: [
                "-y",
                `@creeperhost/modlens-mcp@${version}`,
                "--runtime",
                "--request-file",
                "<local-request-file>",
            ],
        },
        sourceCheckout: {
            note: "For an unpublished build, use a local checkout of this version after npm run build and npm run build:agent (JDK 25, with JDK 17 for the Java 8 entry point). Release packages include the agent.",
            executable: "node",
            arguments: [
                "<local-modlens-checkout>/dist/launcher.js",
                "--runtime",
                "--request-file",
                "<local-request-file>",
            ],
        },
        request,
        lifecycle:
            "The helper starts one persistent, authenticated loopback companion automatically; it collects events between CLI calls. Stop it with the same package command followed by --runtime stop. No second MCP connection or public tunnel is needed.",
        limits: "Codex must have local execution access to the Minecraft PC. This does not wake an idle AI task, and does not connect a cloud-only shell to the user's computer. Do not upload local bridge tokens. Only share diagnostic content needed for the user's task.",
    };
}
