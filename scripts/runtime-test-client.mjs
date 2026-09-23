// Test adapter: run the same fixture through separate CLI processes instead of
// importing RuntimeHub. Each call reconnects to the persistent companion.
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export function runtimeTestClient(root) {
    const launcher = fileURLToPath(new URL("../dist/launcher.js", import.meta.url));
    const env = { ...process.env, MODLENS_CACHE_ROOT: join(root, "helper-cache") };
    const run = (args) =>
        JSON.parse(
            execFileSync(process.execPath, [launcher, "--runtime", ...args], {
                env,
                encoding: "utf8",
                timeout: 45000,
            }),
        );
    async function request(body) {
        const file = join(root, `helper-${randomUUID()}.json`);
        await writeFile(file, JSON.stringify(body));
        return run(["--request-file", file]);
    }
    return {
        setup: (projectDir, mode, gradleTask, minecraftHooks) =>
            request({ action: "setup", projectDir, mode, gradleTask, minecraftHooks }),
        list: () => request({ action: "sessions" }),
        events: (afterCursor, waitMs, sessionId) =>
            request({ action: "events", afterCursor, waitMs, sessionId }),
        command: (sessionId, command) => request({ action: "command", sessionId, command }),
        artifact: (sessionId, artifactName) => request({ action: "artifact", sessionId, artifactName }),
        launch: (projectId, javaHome) => request({ action: "launch", projectId, javaHome }),
        close: async () => run(["stop"]),
    };
}
