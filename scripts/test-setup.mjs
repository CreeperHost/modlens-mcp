import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// npm ci generates the default PostgreSQL client. Generate SQLite before Vitest
// imports application modules, including when tests run before the build in CI.
export default function setup() {
    execFileSync(process.execPath, [
        require.resolve("prisma/build/index.js"), "generate",
        "--schema", fileURLToPath(new URL("../prisma/backends/schema.sqlite.prisma", import.meta.url)),
    ], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
        stdio: "pipe",
    });
}
