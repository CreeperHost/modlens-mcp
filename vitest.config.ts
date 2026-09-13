import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
        globalSetup: ["./scripts/test-setup.mjs"],
    },
});
