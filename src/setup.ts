/**
 * modlens setup wizard — interactive TUI for first-time setup.
 * Usage: npm run setup
 *
 * Handles:
 *   1. PostgreSQL via Docker Compose
 *   2. Schema migration (prisma db push)
 *   3. Ollama (Docker or existing local install) + model pull
 *   4. pgvector extension + embedding columns
 *   5. Embedding backfill for existing docs/primers
 *   6. MCP client config snippet
 */
import * as p from "@clack/prompts";
import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { seedDefaultDocumentation } from "./tools/docs.js";
import { seedDefaultPrimers } from "./tools/primers.js";
import { backfillDocEmbeddings } from "./tools/docs.js";
import { backfillPrimerEmbeddings } from "./tools/primers.js";
import { disconnect } from "./db.js";
import { PKG_ROOT, MODLENS_HOME, ENV_PATH, IS_INSTALLED, ensureModlensHome } from "./env-path.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = PKG_ROOT;
const DEFAULT_GRAPH_REGISTRY_URL = "https://raw.githubusercontent.com/Mattabase/modlens-graphs/main/index.json";
const DEFAULT_EMBED_REGISTRY_URL = "https://raw.githubusercontent.com/Mattabase/modlens-embeddings/main/index.json";

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string, opts?: { cwd?: string; silent?: boolean }): { ok: boolean; out: string } {
    try {
        const out = execSync(cmd, {
            cwd: opts?.cwd ?? ROOT,
            encoding: "utf8",
            stdio: opts?.silent ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        });
        return { ok: true, out: out.trim() };
    } catch (e: unknown) {
        const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
        const msg = [err.stdout, err.stderr].filter(Boolean).join("\n").toString().trim();
        return { ok: false, out: msg };
    }
}

function isCancel(val: unknown): val is symbol {
    return typeof val === "symbol";
}

function checkCancel(val: unknown): void {
    if (isCancel(val)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
    }
}

/** Read existing .env as key→value map */
function readEnv(): Record<string, string> {
    if (!existsSync(ENV_PATH)) return {};
    const map: Record<string, string> = {};
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
        const m = line.match(/^([^#=\s][^=]*)=(.*)/);
        if (m) map[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return map;
}

/** Write key→value map to .env (preserves comments if file exists) */
function writeEnv(vars: Record<string, string>): void {
    ensureModlensHome();
    const lines: string[] = [];
    for (const [k, v] of Object.entries(vars)) {
        lines.push(`${k}=${v}`);
    }
    writeFileSync(ENV_PATH, lines.join("\n") + "\n");
}

/** Wait up to `ms` for a URL to respond OK */
async function waitForHttp(url: string, ms = 30_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return true;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

/** Pull an Ollama model via the HTTP API with a progress spinner */
async function pullOllamaModel(ollamaUrl: string, model: string): Promise<boolean> {
    try {
        const res = await fetch(`${ollamaUrl}/api/pull`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: model }),
        });
        if (!res.ok) return false;
        // Drain the response stream (streaming JSON lines — last line has status:"success")
        const reader = res.body?.getReader();
        if (!reader) return false;
        const decoder = new TextDecoder();
        let lastStatus = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            for (const line of chunk.split("\n").filter(Boolean)) {
                try {
                    const obj = JSON.parse(line) as { status?: string };
                    if (obj.status) lastStatus = obj.status;
                } catch { /* partial line */ }
            }
        }
        return lastStatus === "success" || lastStatus.includes("already");
    } catch {
        return false;
    }
}

/** Detect where VS Code writes its user-level mcp.json */
function vscodeUserMcpPath(): string | null {
    const base = platform() === "win32"
        ? join(process.env.APPDATA ?? homedir(), "Code", "User")
        : join(homedir(), ".config", "Code", "User");
    const insiders = platform() === "win32"
        ? join(process.env.APPDATA ?? homedir(), "Code - Insiders", "User")
        : join(homedir(), ".config", "Code - Insiders", "User");
    // Prefer Insiders if it exists
    for (const dir of [insiders, base]) {
        if (existsSync(dir)) return join(dir, "mcp.json");
    }
    return null;
}

/** Detect Claude Desktop config path */
function claudeDesktopConfigPath(): string | null {
    if (platform() === "win32") {
        return join(process.env.APPDATA ?? homedir(), "Claude", "claude_desktop_config.json");
    }
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

/** Write or merge modlens entry into a JSON MCP config file */
function writeMcpConfig(filePath: string, serverEntry: Record<string, unknown>): boolean {
    try {
        let cfg: Record<string, unknown> = {};
        if (existsSync(filePath)) {
            cfg = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
        }
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        // VS Code uses { servers: { modlens: {...} } }
        // Claude Desktop uses { mcpServers: { modlens: {...} } }
        const isVSCode = filePath.toLowerCase().includes("code");
        const key = isVSCode ? "servers" : "mcpServers";
        const existing = (cfg[key] ?? {}) as Record<string, unknown>;
        existing["modlens"] = serverEntry;
        cfg[key] = existing;
        writeFileSync(filePath, JSON.stringify(cfg, null, 2) + "\n");
        return true;
    } catch {
        return false;
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Detect whether this is a fresh install or a reconfigure run
const existingEnv = readEnv();
const isReconfigure = existsSync(ENV_PATH);

// ── Section selection ─────────────────────────────────────────────────────────
type Section = "containers" | "semantic" | "schema" | "pgvector" | "seed" | "backfill" | "graphs" | "automation" | "mcp";
const ALL_SECTIONS: Section[] = ["containers", "semantic", "schema", "pgvector", "seed", "backfill", "graphs", "automation", "mcp"];

// ── Profile types ─────────────────────────────────────────────────────────────
type ProfileName = "full" | "zero-friction" | "lightweight" | "standard" | "existing" | "custom";

interface Profile {
    name: ProfileName;
    label: string;
    hint: string;
    backend: "postgres" | "pglite" | "sqlite";
    sections: Section[];
    requiresDocker: boolean;
}

const PROFILES: Record<ProfileName, Profile> = {
    "full": {
        name: "full",
        label: "Full power  — Docker Postgres + optional semantic search",
        hint: "recommended",
        backend: "postgres",
        sections: ["containers", "semantic", "schema", "pgvector", "seed", "backfill", "graphs", "automation", "mcp"],
        requiresDocker: true,
    },
    "zero-friction": {
        name: "zero-friction",
        label: "Zero-friction  — PGlite (embedded Postgres, no Docker required)",
        hint: "great for solo use or CI",
        backend: "pglite",
        sections: ["schema", "pgvector", "seed", "backfill", "graphs", "automation", "mcp"],
        requiresDocker: false,
    },
    "lightweight": {
        name: "lightweight",
        label: "Lightweight  — SQLite (fully embedded, no Docker, no semantic search)",
        hint: "smallest footprint",
        backend: "sqlite",
        sections: ["schema", "seed", "automation", "mcp"],
        requiresDocker: false,
    },
    "standard": {
        name: "standard",
        label: "Standard  — Docker Postgres, no semantic search",
        hint: "good default if Ollama is unavailable",
        backend: "postgres",
        sections: ["containers", "schema", "pgvector", "seed", "automation", "mcp"],
        requiresDocker: true,
    },
    "existing": {
        name: "existing",
        label: "Existing Postgres server  — connect to a running Postgres instance",
        hint: "bring your own database",
        backend: "postgres",
        sections: ["schema", "pgvector", "seed", "backfill", "graphs", "automation", "mcp"],
        requiresDocker: false,
    },
    "custom": {
        name: "custom",
        label: "Custom  — choose individual steps",
        hint: "power users",
        backend: "postgres",
        sections: [],
        requiresDocker: false,
    },
};

function detectProfileFromUrl(url: string): ProfileName | null {
    if (!url) return null;
    if (url.startsWith("pglite://") || url.startsWith("pglite:")) return "zero-friction";
    if (url.startsWith("file:") || url.endsWith(".db")) return "lightweight";
    return null; // postgres — could be full/standard/existing/custom
}

if (isReconfigure) {
    p.intro(" modlens — reconfigure ");
    const lines: string[] = [];
    const currentProfileName = (existingEnv.MODLENS_PROFILE as ProfileName | undefined) ?? null;
    const profileLabel = currentProfileName ? (PROFILES[currentProfileName]?.label ?? currentProfileName) : null;
    if (profileLabel)                   lines.push(`  Profile:            ${profileLabel}`);
    if (existingEnv.DATABASE_URL)       lines.push(`  DATABASE_URL:       ${existingEnv.DATABASE_URL}`);
    if (existingEnv.OLLAMA_URL)         lines.push(`  OLLAMA_URL:         ${existingEnv.OLLAMA_URL}`);
    if (existingEnv.OLLAMA_EMBED_MODEL) lines.push(`  OLLAMA_EMBED_MODEL: ${existingEnv.OLLAMA_EMBED_MODEL}`);
    if (existingEnv.CURSEFORGE_API_KEY) lines.push(`  CURSEFORGE_API_KEY: (configured)`);
    if (existingEnv.MODRINTH_TOKEN)     lines.push(`  MODRINTH_TOKEN:     (configured)`);
    if (lines.length) p.log.message("Current config:\n" + lines.join("\n"));
} else {
    p.intro(" modlens setup wizard ");
}

let sections: Set<Section>;
let selectedProfile: ProfileName = (existingEnv.MODLENS_PROFILE as ProfileName | undefined) ?? "full";

if (!isReconfigure) {
    // ── Fresh install: profile picker ─────────────────────────────────────────
    const profileChoice = await p.select<ProfileName>({
        message: "Choose a setup profile",
        options: Object.values(PROFILES).map(pr => ({
            value: pr.name,
            label: pr.label,
            hint: pr.hint,
        })),
    });
    checkCancel(profileChoice);
    selectedProfile = profileChoice as unknown as ProfileName;

    if (selectedProfile === "custom") {
        sections = new Set(ALL_SECTIONS);
    } else if (selectedProfile === "existing") {
        const url = await p.text({
            message: "Enter your Postgres connection URL",
            placeholder: "postgresql://user:password@host:5432/modlens",
            validate: v => ((v ?? "").startsWith("postgresql://") || (v ?? "").startsWith("postgres://"))
                ? undefined : "Must be a postgresql:// URL",
        });
        checkCancel(url);
        writeEnv({ ...readEnv(), DATABASE_URL: url as string });
        sections = new Set(PROFILES["existing"].sections);
    } else if (selectedProfile === "zero-friction") {
        const defaultDir = join(homedir(), ".modlens-data");
        const dataDir = await p.text({
            message: "PGlite data directory (created if it does not exist)",
            initialValue: defaultDir,
        });
        checkCancel(dataDir);
        writeEnv({ ...readEnv(), DATABASE_URL: `pglite://${dataDir as string}` });
        sections = new Set(PROFILES["zero-friction"].sections);
    } else if (selectedProfile === "lightweight") {
        const defaultFile = IS_INSTALLED
            ? join(MODLENS_HOME, "data", "modlens.db")
            : join(homedir(), ".modlens-data", "modlens.db");
        const dbFile = await p.text({
            message: "SQLite database file path (created if it does not exist)",
            initialValue: defaultFile,
        });
        checkCancel(dbFile);
        writeEnv({ ...readEnv(), DATABASE_URL: `file:${dbFile as string}` });
        sections = new Set(PROFILES["lightweight"].sections);
    } else {
        // full / standard — Postgres via Docker
        sections = new Set(PROFILES[selectedProfile].sections);
    }
    writeEnv({ ...readEnv(), MODLENS_PROFILE: selectedProfile });

} else {
    const wizardMode = await p.select({
        message: "What would you like to do?",
        options: [
            { value: "full",   label: "Full wizard   — re-run all steps", hint: "safe for upgrades, all ops are idempotent" },
            { value: "pick",   label: "Pick tasks    — choose which steps to run" },
            { value: "switch", label: "Switch profile — change backend or feature set" },
        ],
    });
    checkCancel(wizardMode);

    if (wizardMode === "full") {
        sections = new Set(ALL_SECTIONS);
    } else if (wizardMode === "switch") {
        // ── Switch profile ────────────────────────────────────────────────────
        const currentUrl = existingEnv.DATABASE_URL ?? "";
        if (currentUrl) {
            const s = p.spinner();
            s.start("Creating backup before switching profile");
            try {
                const { backup } = await import("../scripts/backup.mjs" as string) as {
                    backup: (url: string) => Promise<{ file?: string; dir?: string; restore: string }>
                };
                const result = await backup(currentUrl);
                s.stop(`Backup created: ${result.file ?? result.dir}`);
            } catch (e) {
                s.message(`Backup failed: ${(e as Error).message}`);
                const cont = await p.confirm({ message: "Continue switching profile without backup?" });
                checkCancel(cont);
                if (!cont) process.exit(1);
            }
        }

        const newProfileChoice = await p.select<ProfileName>({
            message: "Switch to which profile?",
            options: Object.values(PROFILES).map(pr => ({
                value: pr.name,
                label: pr.label,
                hint: pr.hint,
            })),
        });
        checkCancel(newProfileChoice);
        selectedProfile = newProfileChoice as unknown as ProfileName;

        let newUrl = "";
        if (selectedProfile === "existing") {
            const url = await p.text({
                message: "Enter your Postgres connection URL",
                placeholder: "postgresql://user:password@host:5432/modlens",
                validate: v => ((v ?? "").startsWith("postgresql://") || (v ?? "").startsWith("postgres://"))
                    ? undefined : "Must be a postgresql:// URL",
            });
            checkCancel(url);
            newUrl = url as string;
        } else if (selectedProfile === "zero-friction") {
            const defaultDir = join(homedir(), ".modlens-data");
            const dataDir = await p.text({
                message: "PGlite data directory",
                initialValue: defaultDir,
            });
            checkCancel(dataDir);
            newUrl = `pglite://${dataDir as string}`;
        } else if (selectedProfile === "lightweight") {
            const defaultFile = join(homedir(), ".modlens-data", "modlens.db");
            const dbFile = await p.text({
                message: "SQLite database file path",
                initialValue: defaultFile,
            });
            checkCancel(dbFile);
            newUrl = `file:${dbFile as string}`;
        } else if (selectedProfile === "full" || selectedProfile === "standard") {
            newUrl = "postgresql://modlens:modlens@localhost:5433/modlens";
        } else {
            newUrl = currentUrl;
        }

        if (currentUrl && newUrl && currentUrl !== newUrl) {
            const wantMigrate = await p.confirm({
                message: "Migrate existing data (mods, docs, primers) to new backend? (MC source not migrated — too large)",
                initialValue: true,
            });
            checkCancel(wantMigrate);
            if (wantMigrate) {
                const s = p.spinner();
                s.start("Migrating data");
                try {
                    const { migrate } = await import("../scripts/migrate-backend.mjs" as string) as {
                        migrate: (src: string, tgt: string) => Promise<void>
                    };
                    await migrate(currentUrl, newUrl);
                    s.stop("Migration complete");
                } catch (e) {
                    s.message(`Migration failed: ${(e as Error).message}`);
                    p.log.warn("Re-run manually: SOURCE_DATABASE_URL=<old> DATABASE_URL=<new> node scripts/migrate-backend.mjs");
                }
            }
        }

        if (currentUrl && currentUrl !== newUrl) {
            const wantCleanup = await p.confirm({
                message: "Delete old backend data? (backup was saved — this frees disk space)",
                initialValue: false,
            });
            checkCancel(wantCleanup);
            if (wantCleanup) {
                const { rmSync } = await import("fs");
                const oldProfileKind = detectProfileFromUrl(currentUrl);
                if (oldProfileKind === "zero-friction") {
                    const dataDir = currentUrl.replace(/^pglite:\/\//, "");
                    rmSync(dataDir, { recursive: true, force: true });
                    p.log.success(`Removed PGlite data directory: ${dataDir}`);
                } else if (oldProfileKind === "lightweight") {
                    const dbPath = currentUrl.replace(/^file:\/\//, "").replace(/^file:/, "");
                    rmSync(dbPath, { force: true });
                    p.log.success(`Removed SQLite database: ${dbPath}`);
                } else {
                    p.log.warn("Cannot auto-clean Postgres data. To remove: docker compose down -v");
                }
            }
        }

        writeEnv({ ...readEnv(), DATABASE_URL: newUrl, MODLENS_PROFILE: selectedProfile });
        sections = new Set(selectedProfile === "custom" ? ALL_SECTIONS : PROFILES[selectedProfile].sections);

    } else {
        const hasSemantic = !!existingEnv.OLLAMA_URL;
        const selected = await p.multiselect<Section>({
            message: "Select sections to run  (space to toggle, enter to confirm)",
            options: [
                { value: "containers", label: "Start / verify Docker containers" },
                { value: "semantic",   label: "Semantic search config",
                  hint: hasSemantic ? `current: ${existingEnv.OLLAMA_URL}` : "not configured — add Ollama" },
                { value: "schema",     label: "Re-apply Prisma schema" },
                { value: "pgvector",   label: "pgvector / sqlite-vec extension + embedding columns",
                  hint: hasSemantic ? "already enabled" : "required for semantic search" },
                { value: "seed",       label: "Re-seed default docs and primers" },
                { value: "backfill",   label: "Re-generate embeddings (docs + primers)",
                  hint: hasSemantic ? "" : "requires Ollama" },
                { value: "graphs",     label: "Graph extraction config (Graphify)" },
                { value: "automation", label: "Automation preferences (auto-embed, auto-graph, auto-cache)" },
                { value: "mcp",        label: "Update MCP client config" },
            ],
            initialValues: hasSemantic ? [] : (["semantic", "pgvector", "backfill"] as Section[]),
            required: false,
        });
        checkCancel(selected);
        sections = new Set(selected as unknown as Section[]);
    }

    if (sections.size === 0) {
        p.outro("Nothing selected — no changes made.");
        await disconnect();
        process.exit(0);
    }
}

// ── Check Docker (only required for container-using profiles) ────────────────
const profileNeedsDocker = selectedProfile === "custom"
    ? sections.has("containers")
    : (PROFILES[selectedProfile]?.requiresDocker ?? false);

if (profileNeedsDocker) {
    const s = p.spinner();
    s.start("Checking Docker");
    const docker = run("docker info", { silent: true });
    if (!docker.ok) {
        s.error("Docker not found or not running");
        p.log.error("Please install Docker Desktop and make sure it is running, then re-run setup.");
        process.exit(1);
    }
    s.stop("Docker is running");
}

// ── Semantic search / Ollama config ──────────────────────────────────────────
// Initialise from existing .env so non-semantic sections can read these
let wantSemantic: boolean = !!existingEnv.OLLAMA_URL;
let ollamaUrl: string = existingEnv.OLLAMA_URL ?? "http://localhost:11434";
let embedModel: string = existingEnv.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
let ollamaMode: string = "skip"; // "docker" | "local" | "remote" | "skip"
const DOCKER_OLLAMA_URL = "http://localhost:11435";
const MODEL_DIMS: Record<string, string> = {
    "nomic-embed-text":  "768",
    "mxbai-embed-large": "1024",
};
const MODEL_CHUNK: Record<string, string> = {
    "nomic-embed-text":  "1500",
    "mxbai-embed-large": "500",
};

if (sections.has("semantic")) {
    const answer = await p.confirm({
        message: "Enable semantic search? (Ollama + pgvector — optional but recommended)",
        initialValue: wantSemantic,
    });
    checkCancel(answer);
    wantSemantic = answer as boolean;

    if (wantSemantic) {
        const mode = await p.select({
            message: "How should Ollama run?",
            options: [
                { value: "docker", label: "Docker  (managed by this project's docker-compose — easiest)", hint: "recommended" },
                { value: "local",  label: "Local install  (Ollama already installed on this machine)" },
                { value: "remote", label: "Remote  (Ollama running on another machine)" },
            ],
        });
        checkCancel(mode);
        ollamaMode = mode as string;
        if (ollamaMode === "docker") ollamaUrl = DOCKER_OLLAMA_URL;

        if (ollamaMode === "remote") {
            const existingRemote = existingEnv.OLLAMA_URL?.startsWith("http://localhost") ||
                                   existingEnv.OLLAMA_URL?.startsWith("http://127") ? "" : (existingEnv.OLLAMA_URL ?? "");
            const url = await p.text({
                message: "Ollama base URL",
                placeholder: "http://192.168.1.x:11434",
                initialValue: existingRemote,
                validate: v => (v ?? "").startsWith("http") ? undefined : "Must start with http:// or https://",
            });
            checkCancel(url);
            ollamaUrl = url as string;
        }

        const modelChoice = await p.select({
            message: "Embedding model",
            options: [
                { value: "nomic-embed-text",  label: "nomic-embed-text  (768-dim, fast, good quality)", hint: "recommended" },
                { value: "mxbai-embed-large", label: "mxbai-embed-large  (1024-dim, higher quality, slower)" },
                { value: "custom",            label: "Custom model name" },
            ],
        });
        checkCancel(modelChoice);

        if (modelChoice === "custom") {
            const custom = await p.text({
                message: "Model name (as shown in `ollama list`)",
                initialValue: existingEnv.OLLAMA_EMBED_MODEL ?? "",
            });
            checkCancel(custom);
            embedModel = custom as string;
        } else {
            embedModel = modelChoice as string;
        }
    } else {
        ollamaMode = "skip";
    }
} else if (wantSemantic) {
    // Semantic not reconfigured — infer ollamaMode from existing URL for container startup
    ollamaMode = existingEnv.OLLAMA_URL === DOCKER_OLLAMA_URL
        ? "docker"   // Docker-managed modlens-ollama on port 11435
        : existingEnv.OLLAMA_URL?.startsWith("http://localhost") || existingEnv.OLLAMA_URL?.startsWith("http://127")
            ? "local"    // local Ollama install
            : "remote";  // remote Ollama — don't need to start local container
}

// ── Start Docker containers ───────────────────────────────────────────────────
if (sections.has("containers")) {
    const profile = wantSemantic && ollamaMode === "docker" ? "--profile semantic" : "";
    {
        const s = p.spinner();
        s.start("Starting Docker containers");
        const up = run(`docker compose ${profile} up -d`);
        if (!up.ok) {
            s.error("Failed to start containers");
            p.log.error(up.out);
            process.exit(1);
        }
        s.stop("Containers started");
    }

    // Wait for Ollama (only when we just started or reconfigured it)
    if (wantSemantic && (ollamaMode === "docker" || ollamaMode === "local")) {
        const s = p.spinner();
        s.start(`Waiting for Ollama at ${ollamaUrl}`);
        const ready = await waitForHttp(`${ollamaUrl}/api/tags`, ollamaMode === "docker" ? 60_000 : 10_000);
        if (!ready) {
            s.error("Ollama did not respond in time");
            if (ollamaMode === "local") p.log.warn("Make sure Ollama is running: `ollama serve`");
            const cont = await p.confirm({ message: "Continue anyway (skip model pull)?" });
            checkCancel(cont);
            if (!cont) process.exit(1);
        } else {
            s.stop("Ollama is ready");
            const s2 = p.spinner();
            s2.start(`Pulling model ${embedModel} (may take a few minutes on first run)`);
            const ok = await pullOllamaModel(ollamaUrl, embedModel);
            s2.stop(ok
                ? `Model ${embedModel} ready`
                : `Pull may not have completed — check with: docker exec modlens-ollama ollama list`);
        }
    }

    // Wait for PostgreSQL
    {
        const s = p.spinner();
        s.start("Waiting for PostgreSQL");
        let healthy = false;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            const r = run("docker exec modlens-postgres pg_isready -U modlens", { silent: true });
            if (r.ok) { healthy = true; break; }
            await new Promise(r2 => setTimeout(r2, 1000));
        }
        s.stop(healthy ? "PostgreSQL is ready" : "PostgreSQL health check timed out — continuing anyway");
    }
} else if (sections.has("semantic") && wantSemantic && ollamaMode === "docker") {
    // Semantic config changed to Docker Ollama but containers section wasn't selected — start quietly
    const s = p.spinner();
    s.start("Starting containers with semantic profile");
    const up = run("docker compose --profile semantic up -d");
    s.stop(up.ok ? "Containers updated" : "Container update had warnings — run: docker compose --profile semantic up -d");

    const s2 = p.spinner();
    s2.start(`Waiting for Ollama at ${ollamaUrl}`);
    const ready = await waitForHttp(`${ollamaUrl}/api/tags`, 60_000);
    if (ready) {
        s2.stop("Ollama is ready");
        const s3 = p.spinner();
        s3.start(`Pulling model ${embedModel}`);
        const ok = await pullOllamaModel(ollamaUrl, embedModel);
        s3.stop(ok ? `Model ${embedModel} ready` : "Pull may not have completed");
    } else {
        s2.stop("Ollama did not respond — continuing");
    }
}

// ── Write .env ────────────────────────────────────────────────────────────────
if (sections.has("semantic") || sections.has("containers") || !isReconfigure) {
    const env: Record<string, string> = {
        DATABASE_URL: existingEnv.DATABASE_URL ?? "postgresql://modlens:modlens@localhost:5433/modlens",
        ...(wantSemantic ? {
            OLLAMA_URL:         ollamaUrl,
            OLLAMA_EMBED_MODEL: embedModel,
            OLLAMA_EMBED_DIM:   MODEL_DIMS[embedModel] ?? existingEnv.OLLAMA_EMBED_DIM ?? "768",
            OLLAMA_EMBED_CHUNK: MODEL_CHUNK[embedModel] ?? existingEnv.OLLAMA_EMBED_CHUNK ?? "500",
        } : {}),
    };
    if (existingEnv.CURSEFORGE_API_KEY) env.CURSEFORGE_API_KEY = existingEnv.CURSEFORGE_API_KEY;
    if (existingEnv.MODRINTH_TOKEN)     env.MODRINTH_TOKEN     = existingEnv.MODRINTH_TOKEN;
    writeEnv(env);
    p.log.success(".env written");
}

// ── Prisma schema ─────────────────────────────────────────────────────────────
if (sections.has("schema")) {
    const backend = PROFILES[selectedProfile]?.backend ?? "postgres";

    // On Postgres/PGlite the schema contains `embedding vector(N)` columns.
    // The `vector` type requires the pgvector extension to exist BEFORE
    // prisma db push — so enable the extension here, quietly.
    if (backend !== "sqlite") {
        const spre = p.spinner();
        spre.start("Enabling pgvector extension (required before schema push)");
        const rpre = run("node scripts/enable-pgvector.mjs", { silent: true });
        if (rpre.ok) {
            spre.stop("pgvector extension ready");
        } else {
            // Non-fatal — the extension may already exist or the script may
            // have partially succeeded; prisma db push will tell us if not.
            spre.stop("pgvector pre-check had warnings (continuing)");
        }
    }

    const s = p.spinner();
    s.start("Applying database schema (prisma db push)");
    const schemaArg = backend === "sqlite"
        ? "--schema prisma/backends/schema.sqlite.prisma"
        : "";
    const r = run(`npx prisma db push ${schemaArg} --skip-generate`, { silent: true });
    if (!r.ok) {
        s.error("prisma db push failed");
        p.log.error(r.out.slice(0, 500));
        process.exit(1);
    }
    s.stop("Database schema applied");
}

// ── pgvector / sqlite-vec ─────────────────────────────────────────────────────
if (sections.has("pgvector")) {
    const backend = PROFILES[selectedProfile]?.backend;
    if (backend === "sqlite") {
        const s = p.spinner();
        s.start("Setting up FTS5 tables and sqlite-vec");
        const r = run("node scripts/enable-sqlite-vec.mjs");
        if (!r.ok) {
            s.error("sqlite-vec setup failed");
            p.log.error(r.out.slice(0, 500));
            p.log.warn("You can retry manually: npm run db:vector:sqlite");
        } else {
            s.stop("SQLite FTS5 and sqlite-vec ready");
        }
    } else if (!wantSemantic) {
        p.log.warn("pgvector skipped — semantic search is not enabled");
    } else {
        const s = p.spinner();
        s.start("Enabling pgvector extension and adding embedding columns");
        const r = run("node scripts/enable-pgvector.mjs");
        if (!r.ok) {
            s.error("pgvector setup failed");
            p.log.error(r.out.slice(0, 500));
            p.log.warn("You can retry manually: npm run db:vector");
        } else {
            s.stop("pgvector ready");
        }
    }
}

// ── Seed docs + primers ───────────────────────────────────────────────────────
if (sections.has("seed")) {
    const wantSeed = await p.confirm({
        message: isReconfigure
            ? "Re-seed default docs and primers? (safe — uses upsert, will not delete custom entries)"
            : "Seed default documentation and migration primers?",
        initialValue: true,
    });
    checkCancel(wantSeed);

    if (wantSeed) {
        const s = p.spinner();
        s.start("Seeding docs and primers");
        try {
            await seedDefaultDocumentation();
            await seedDefaultPrimers();
            s.stop("Docs and primers seeded");
        } catch {
            s.stop("Seed had warnings (data may already exist — that is fine)");
        }
    }
}

// ── Embedding backfill ────────────────────────────────────────────────────────
if (sections.has("backfill")) {
    if (!wantSemantic) {
        p.log.warn("Embedding backfill skipped — semantic search is not enabled");
    } else {
        const wantBackfill = await p.confirm({
            message: isReconfigure
                ? "Re-generate embeddings for docs and primers? (overwrites existing)"
                : "Embed existing docs and primers now for semantic search?",
            initialValue: true,
        });
        checkCancel(wantBackfill);

        if (wantBackfill) {
            const s = p.spinner();
            s.start("Generating embeddings (docs + primers)");
            try {
                await backfillDocEmbeddings();
                await backfillPrimerEmbeddings();
                s.stop("Embeddings generated");
            } catch {
                s.stop("Backfill had errors — run `node dist/cli.js backfill-embeddings` to retry");
            }
        }
    }
}

// ── Graph extraction (Graphify) ───────────────────────────────────────────────
if (sections.has("graphs")) {
    const wantGraphs = await p.confirm({
        message: "Set up graph extraction + optional distribution registry URLs?",
        initialValue: true,
    });
    checkCancel(wantGraphs);

    if (wantGraphs) {
        p.log.message("This step configures graph extraction. Graph/embed downloads only work after you publish registry index URLs.");

        // Check if graphify CLI is installed
        const graphifyCheck = run("graphify --version", { silent: true });
        if (!graphifyCheck.ok) {
            const installGraphify = await p.confirm({
                message: "graphify CLI not found. Install it? (requires Python + uv/pip)",
                initialValue: true,
            });
            checkCancel(installGraphify);

            if (installGraphify) {
                const s = p.spinner();
                s.start("Installing graphify CLI (uv tool install graphifyy)");
                const uvResult = run("uv tool install graphifyy", { silent: true });
                if (!uvResult.ok) {
                    const pipResult = run("pip install graphifyy", { silent: true });
                    if (!pipResult.ok) {
                        s.stop("Could not install graphify — install manually: uv tool install graphifyy");
                    } else {
                        s.stop("graphify installed via pip");
                    }
                } else {
                    s.stop("graphify installed via uv");
                }
            }
        } else {
            p.log.success(`graphify CLI found: ${graphifyCheck.out.trim()}`);
        }

        // Backend selection
        const backendChoice = await p.select({
            message: "Graph extraction backend:",
            options: [
                { value: "auto",     label: "Auto-detect  — picks best available (Ollama → cloud → AST-only)" },
                { value: "ollama",   label: "Ollama  — local, free, private" },
                { value: "gemini",   label: "Gemini  — Google AI, fast, cheap" },
                { value: "deepseek", label: "DeepSeek  — affordable cloud" },
                { value: "openai",   label: "OpenAI  — GPT models" },
                { value: "claude",   label: "Claude  — Anthropic" },
                { value: "kimi",     label: "Kimi  — Moonshot AI" },
                { value: "custom",   label: "Custom  — any OpenAI-compatible endpoint" },
                { value: "ast-only", label: "AST-only  — no LLM, structural analysis only (free)" },
            ],
            initialValue: "auto",
        });
        checkCancel(backendChoice);

        const graphEnv: Record<string, string> = {};
        const back = backendChoice as string;

        if (back !== "auto") {
            graphEnv.GRAPHIFY_BACKEND = back;
        }

        // Prompt for API keys based on backend choice
        if (back === "gemini" || back === "auto") {
            const existing = existingEnv.GEMINI_API_KEY;
            if (!existing) {
                const key = await p.text({ message: "Gemini API key (leave blank to skip):", initialValue: "" });
                checkCancel(key);
                if (key) graphEnv.GEMINI_API_KEY = key as string;
            }
        }
        if (back === "deepseek") {
            const key = await p.text({ message: "DeepSeek API key:", initialValue: existingEnv.DEEPSEEK_API_KEY ?? "" });
            checkCancel(key);
            if (key) graphEnv.DEEPSEEK_API_KEY = key as string;
        }
        if (back === "openai") {
            const key = await p.text({ message: "OpenAI API key:", initialValue: existingEnv.OPENAI_API_KEY ?? "" });
            checkCancel(key);
            if (key) graphEnv.OPENAI_API_KEY = key as string;
        }
        if (back === "claude") {
            const key = await p.text({ message: "Anthropic API key:", initialValue: existingEnv.ANTHROPIC_API_KEY ?? "" });
            checkCancel(key);
            if (key) graphEnv.ANTHROPIC_API_KEY = key as string;
        }
        if (back === "kimi") {
            const key = await p.text({ message: "Kimi/Moonshot API key:", initialValue: existingEnv.KIMI_API_KEY ?? "" });
            checkCancel(key);
            if (key) graphEnv.KIMI_API_KEY = key as string;
        }
        if (back === "custom") {
            const baseUrl = await p.text({ message: "Custom endpoint base URL:", initialValue: existingEnv.GRAPHIFY_CUSTOM_BASE_URL ?? "" });
            checkCancel(baseUrl);
            if (baseUrl) graphEnv.GRAPHIFY_CUSTOM_BASE_URL = baseUrl as string;

            const apiKey = await p.text({ message: "Custom endpoint API key:", initialValue: existingEnv.GRAPHIFY_CUSTOM_API_KEY ?? "" });
            checkCancel(apiKey);
            if (apiKey) graphEnv.GRAPHIFY_CUSTOM_API_KEY = apiKey as string;

            const model = await p.text({ message: "Custom endpoint model name:", initialValue: existingEnv.GRAPHIFY_CUSTOM_MODEL ?? "" });
            checkCancel(model);
            if (model) graphEnv.GRAPHIFY_CUSTOM_MODEL = model as string;
        }

        // Warn if a cloud backend was chosen but no API key is configured
        const cloudKeyMap: Record<string, string[]> = {
            gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
            deepseek: ["DEEPSEEK_API_KEY"],
            openai: ["OPENAI_API_KEY"],
            claude: ["ANTHROPIC_API_KEY"],
            kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
            custom: ["GRAPHIFY_CUSTOM_API_KEY"],
        };
        const requiredKeys = cloudKeyMap[back];
        if (requiredKeys) {
            const hasKey = requiredKeys.some(k => graphEnv[k] || existingEnv[k]);
            if (!hasKey) {
                p.log.warn(`⚠ No API key set for ${back} — graph extraction will fall back to AST-only until a key is provided.`);
            }
        }

        const currentGraphRegistry = (existingEnv.MODLENS_GRAPH_REGISTRY_URL ?? "").trim() || DEFAULT_GRAPH_REGISTRY_URL;
        const currentEmbedRegistry = (existingEnv.MODLENS_EMBED_REGISTRY_URL ?? "").trim() || DEFAULT_EMBED_REGISTRY_URL;

        const useDefaultRegistryUrls = await p.confirm({
            message: "Use default registry URLs for graph_download/embed_download?",
            initialValue: true,
        });
        checkCancel(useDefaultRegistryUrls);

        if (useDefaultRegistryUrls) {
            graphEnv.MODLENS_GRAPH_REGISTRY_URL = DEFAULT_GRAPH_REGISTRY_URL;
            graphEnv.MODLENS_EMBED_REGISTRY_URL = DEFAULT_EMBED_REGISTRY_URL;
            p.log.message(`Graph registry: ${DEFAULT_GRAPH_REGISTRY_URL}`);
            p.log.message(`Embed registry: ${DEFAULT_EMBED_REGISTRY_URL}`);
        } else {
            const graphRegistryUrl = await p.text({
                message: "Graph registry index URL",
                initialValue: currentGraphRegistry,
                placeholder: "https://.../index.json",
            });
            checkCancel(graphRegistryUrl);

            const embedRegistryUrl = await p.text({
                message: "Embedding registry index URL",
                initialValue: currentEmbedRegistry,
                placeholder: "https://.../index.json",
            });
            checkCancel(embedRegistryUrl);

            graphEnv.MODLENS_GRAPH_REGISTRY_URL = (graphRegistryUrl as string).trim() || DEFAULT_GRAPH_REGISTRY_URL;
            graphEnv.MODLENS_EMBED_REGISTRY_URL = (embedRegistryUrl as string).trim() || DEFAULT_EMBED_REGISTRY_URL;
        }

        // Save graph-related env vars
        if (Object.keys(graphEnv).length > 0) {
            writeEnv({ ...readEnv(), ...graphEnv });
            p.log.success("Graph extraction config saved");
        }
    }
}

// ── Automation preferences ────────────────────────────────────────────────────
if (sections.has("automation")) {
    const autoEnv: Record<string, string> = {};

    // Current defaults: all "1" (on) unless explicitly set to "0"
    const currentAutoEmbed = existingEnv.MODLENS_AUTO_EMBED !== "0";
    const currentAutoGraph = existingEnv.MODLENS_AUTO_GRAPH !== "0";
    const currentAutoEmbedStartup = existingEnv.MODLENS_AUTO_EMBED !== "0";
    const currentAutoCacheDiffs = existingEnv.AUTO_CACHE_MOD_DIFFS === "1";
    // Batch defaults: OFF unless explicitly set to "1"
    const currentBatchAutoEmbed = existingEnv.MODLENS_BATCH_AUTO_EMBED === "1";
    const currentBatchAutoGraph = existingEnv.MODLENS_BATCH_AUTO_GRAPH === "1";

    p.log.message("These settings control what happens automatically after tool actions.\nEach can also be overridden per-call with autoEmbed/autoGraph parameters.");

    const autoChoices = await p.multiselect({
        message: "Select which auto-behaviors to enable  (space to toggle)",
        options: [
            {
                value: "autoEmbed",
                label: "Auto-embed on decompile",
                hint: "Queue semantic embeddings when decompile completes (requires Ollama)",
            },
            {
                value: "autoGraph",
                label: "Auto-build graph on decompile / source download",
                hint: "Build knowledge graph when decompile completes or source is downloaded",
            },
            {
                value: "autoEmbedStartup",
                label: "Auto-embed scan on startup",
                hint: "Re-queue unfinished embeddings when the server starts",
            },
            {
                value: "batchAutoEmbed",
                label: "Auto-embed during batch_decompile",
                hint: "Also queue embeddings during batch operations (slower but hands-free)",
            },
            {
                value: "batchAutoGraph",
                label: "Auto-build graph during batch_decompile",
                hint: "Also build graphs during batch operations (slower but hands-free)",
            },
            {
                value: "autoCacheDiffs",
                label: "Auto-cache mod diffs",
                hint: "Cache diff_detailed results to DB automatically",
            },
        ],
        initialValues: [
            ...(currentAutoEmbed ? ["autoEmbed"] : []),
            ...(currentAutoGraph ? ["autoGraph"] : []),
            ...(currentAutoEmbedStartup ? ["autoEmbedStartup"] : []),
            ...(currentBatchAutoEmbed ? ["batchAutoEmbed"] : []),
            ...(currentBatchAutoGraph ? ["batchAutoGraph"] : []),
            ...(currentAutoCacheDiffs ? ["autoCacheDiffs"] : []),
        ] as string[],
        required: false,
    });
    checkCancel(autoChoices);

    const choices = new Set(autoChoices as unknown as string[]);
    // MODLENS_AUTO_EMBED controls both per-decompile and startup scan
    autoEnv.MODLENS_AUTO_EMBED = (choices.has("autoEmbed") || choices.has("autoEmbedStartup")) ? "1" : "0";
    autoEnv.MODLENS_AUTO_GRAPH = choices.has("autoGraph") ? "1" : "0";
    autoEnv.MODLENS_BATCH_AUTO_EMBED = choices.has("batchAutoEmbed") ? "1" : "";
    autoEnv.MODLENS_BATCH_AUTO_GRAPH = choices.has("batchAutoGraph") ? "1" : "";
    autoEnv.AUTO_CACHE_MOD_DIFFS = choices.has("autoCacheDiffs") ? "1" : "";

    writeEnv({ ...readEnv(), ...autoEnv });
    p.log.success("Automation preferences saved");
}

// ── Primer security ───────────────────────────────────────────────────────────
if (sections.has("automation")) {
    const { DEFAULT_PRIMER_HOSTS } = await import("./tools/primers.js");
    const secEnv: Record<string, string> = {};
    const currentAllowAny = existingEnv.MODLENS_PRIMER_ALLOW_ANY_HTTPS === "1";
    const currentExtraHosts = existingEnv.MODLENS_PRIMER_ALLOWED_HOSTS ?? "";

    p.log.message(
        `Primer URL security: when fetchContent is enabled, primers are fetched server-side.\n` +
        `Default allowed hosts: ${DEFAULT_PRIMER_HOSTS.slice(0, 5).join(", ")}… (${DEFAULT_PRIMER_HOSTS.length} total)\n` +
        `You can add extra hosts or allow any HTTPS URL.`
    );

    const primerMode = await p.select({
        message: "Primer URL security mode",
        options: [
            { value: "default", label: "Allowlist only (recommended)", hint: `${DEFAULT_PRIMER_HOSTS.length} known modding sites` },
            { value: "extra",   label: "Allowlist + extra hosts",      hint: "Add custom domains" },
            { value: "any",     label: "Allow any HTTPS URL",          hint: "Less secure — trusts all HTTPS sources" },
        ],
        initialValue: currentAllowAny ? "any" : currentExtraHosts ? "extra" : "default",
    });
    checkCancel(primerMode);

    if (primerMode === "any") {
        secEnv.MODLENS_PRIMER_ALLOW_ANY_HTTPS = "1";
        secEnv.MODLENS_PRIMER_ALLOWED_HOSTS = "";
    } else if (primerMode === "extra") {
        secEnv.MODLENS_PRIMER_ALLOW_ANY_HTTPS = "";
        const extraHosts = await p.text({
            message: "Extra allowed hostnames (comma-separated)",
            placeholder: "myblog.example.com, wiki.modloader.dev",
            initialValue: currentExtraHosts,
        });
        checkCancel(extraHosts);
        secEnv.MODLENS_PRIMER_ALLOWED_HOSTS = (extraHosts as string).trim();
    } else {
        secEnv.MODLENS_PRIMER_ALLOW_ANY_HTTPS = "";
        secEnv.MODLENS_PRIMER_ALLOWED_HOSTS = "";
    }

    writeEnv({ ...readEnv(), ...secEnv });
    p.log.success("Primer security preferences saved");
}

// ── MCP client config ─────────────────────────────────────────────────────────
if (sections.has("mcp")) {
    // For npx/installed mode: env is loaded from ~/.modlens/.env by the launcher,
    // so we don't need to embed vars in the MCP config — just the command.
    // For git-clone mode: keep the existing node + env approach.
    const pkgVersion: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
    const envVars: Record<string, string> = IS_INSTALLED ? {} : {
        DATABASE_URL: existingEnv.DATABASE_URL ?? "postgresql://modlens:modlens@localhost:5433/modlens",
        ...(wantSemantic ? {
            OLLAMA_URL:         ollamaUrl,
            OLLAMA_EMBED_MODEL: embedModel,
            OLLAMA_EMBED_DIM:   MODEL_DIMS[embedModel] ?? existingEnv.OLLAMA_EMBED_DIM ?? "768",
            OLLAMA_EMBED_CHUNK: MODEL_CHUNK[embedModel] ?? existingEnv.OLLAMA_EMBED_CHUNK ?? "500",
        } : {}),
    };

    const serverPath = join(ROOT, "dist", "server.js").replace(/\\/g, "/");
    // Pinned version so MCP client never auto-updates mid-project
    const npxArgs = ["-y", `@mattabase/modlens-mcp@${pkgVersion}`];

    const vscodeEntry = IS_INSTALLED
        ? { type: "stdio", command: "npx", args: npxArgs }
        : { type: "stdio", command: "node", args: [serverPath], env: envVars };
    const claudeEntry = IS_INSTALLED
        ? { command: "npx", args: npxArgs }
        : { command: "node", args: [serverPath], env: envVars };

    const mcpClient = await p.select({
        message: "Configure MCP client?",
        options: [
            { value: "vscode", label: "VS Code (user-level mcp.json)" },
            { value: "claude", label: "Claude Desktop" },
            { value: "show",   label: "Show config snippet — I'll add it myself" },
            { value: "skip",   label: "Skip" },
        ],
    });
    checkCancel(mcpClient);

    if (mcpClient === "vscode") {
        const mcpPath = vscodeUserMcpPath();
        if (!mcpPath) {
            p.log.warn("Could not find VS Code user directory — showing snippet instead.");
            p.log.info(JSON.stringify({ servers: { modlens: vscodeEntry } }, null, 2));
        } else {
            const ok = writeMcpConfig(mcpPath, vscodeEntry);
            if (ok) p.log.success(`Written to ${mcpPath}`);
            else p.log.warn(`Failed to write to ${mcpPath} — add manually.`);
        }
    } else if (mcpClient === "claude") {
        const cfgPath = claudeDesktopConfigPath();
        if (!cfgPath) {
            p.log.warn("Could not find Claude Desktop config path — showing snippet instead.");
            p.log.info(JSON.stringify({ mcpServers: { modlens: claudeEntry } }, null, 2));
        } else {
            const ok = writeMcpConfig(cfgPath, claudeEntry);
            if (ok) p.log.success(`Written to ${cfgPath}`);
            else p.log.warn(`Failed to write to ${cfgPath} — add manually.`);
        }
    } else if (mcpClient === "show") {
        p.log.message("\n── VS Code (mcp.json) ──");
        p.log.info(JSON.stringify({ servers: { modlens: vscodeEntry } }, null, 2));
        p.log.message("\n── Claude Desktop ──");
        p.log.info(JSON.stringify({ mcpServers: { modlens: claudeEntry } }, null, 2));
    }
}

// ── Done ──────────────────────────────────────────────────────────────────────
p.outro(
    isReconfigure
        ? "Done! Restart your MCP client if you changed the server config."
        : wantSemantic
            ? "modlens is ready with semantic search! Restart your MCP client to pick up the server."
            : "modlens is ready! Restart your MCP client to pick up the server.",
);

await disconnect();
