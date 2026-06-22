/**
 * Builds the prebuilt SQLite template database that ships in the package.
 *
 * On first run as an installed package (npx / global), the launcher copies this
 * template to `~/.modlens/data/modlens.db` so the embedded SQLite backend works
 * with zero configuration — no `prisma db push`, no Prisma CLI, no engines, and
 * no interactive setup required at runtime.
 *
 * The template is a build artifact (gitignored) regenerated on every `build`,
 * so its schema is always in sync with `prisma/backends/schema.sqlite.prisma`.
 */
import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = join(ROOT, "prisma", "backends", "template.db");

// Start from a clean slate so the template never carries stale tables/rows.
if (existsSync(dbFile)) rmSync(dbFile);

// Prisma resolves a relative `file:` URL relative to the schema file's directory
// (prisma/backends/), so `file:./template.db` lands the db next to the schema.
execSync(
    "npx prisma db push --schema prisma/backends/schema.sqlite.prisma --skip-generate --accept-data-loss",
    {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: "file:./template.db" },
    },
);

if (!existsSync(dbFile)) {
    console.error(`[build-template-db] expected template at ${dbFile} but it was not created.`);
    process.exit(1);
}
console.log(`[build-template-db] built template database at ${dbFile}`);
