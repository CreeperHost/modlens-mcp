/**
 * Resolves MODLENS_HOME and ENV_PATH depending on how the tool was installed.
 *
 * - **npx / global install**: no `.git` at the package root → user data lives
 *   in `~/.modlens/` so it survives package cache evictions between updates.
 * - **git clone**: `.git` exists → keep existing behaviour (`.env` at project
 *   root, no MODLENS_HOME needed).
 *
 * Import this module wherever you need ENV_PATH or MODLENS_HOME instead of
 * hard-coding paths relative to `__dirname`.
 */
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the package root (where package.json lives). */
export const PKG_ROOT = join(__dirname, "..");

/**
 * True when running as an npx / globally-installed package (no `.git` at root).
 * False for git-clone / development installs.
 */
export const IS_INSTALLED = !existsSync(join(PKG_ROOT, ".git"));

/**
 * Directory that owns persistent user data (`.env`, DB, version sentinel).
 *
 * - Installed: `~/.modlens/`
 * - Git clone:  the project root (unchanged behaviour)
 */
export const MODLENS_HOME: string =
    process.env.MODLENS_HOME ??
    (IS_INSTALLED ? join(homedir(), ".modlens") : PKG_ROOT);

/** Absolute path to the `.env` file that setup reads/writes and server loads. */
export const ENV_PATH = IS_INSTALLED
    ? join(MODLENS_HOME, ".env")
    : join(PKG_ROOT, ".env");

/** Ensure MODLENS_HOME exists (safe to call multiple times). */
export function ensureModlensHome(): void {
    mkdirSync(MODLENS_HOME, { recursive: true });
}
