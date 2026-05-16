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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENV_PATH = join(ROOT, ".env");

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

p.intro(" modlens setup wizard ");

// ── Step 1: Check Docker ──────────────────────────────────────────────────────
{
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

// ── Step 2: Semantic search / Ollama ─────────────────────────────────────────
const wantSemantic = await p.confirm({
    message: "Enable semantic search? (Ollama + pgvector — optional but recommended)",
    initialValue: true,
});
checkCancel(wantSemantic);

let ollamaUrl = "http://localhost:11434";
let embedModel = "nomic-embed-text";

if (wantSemantic) {
    // Ask how to run Ollama
    const ollamaMode = await p.select({
        message: "How should Ollama run?",
        options: [
            { value: "docker",  label: "Docker  (managed by this project's docker-compose — easiest)", hint: "recommended" },
            { value: "local",   label: "Local install  (Ollama already installed on this machine)" },
            { value: "remote",  label: "Remote  (Ollama running on another machine)" },
        ],
    });
    checkCancel(ollamaMode);

    if (ollamaMode === "remote") {
        const url = await p.text({
            message: "Ollama base URL",
            placeholder: "http://192.168.1.x:11434",
            validate: v => (v ?? "").startsWith("http") ? undefined : "Must start with http:// or https://",
        });
        checkCancel(url);
        ollamaUrl = url as string;
    }

    const modelChoice = await p.select({
        message: "Embedding model",
        options: [
            { value: "nomic-embed-text", label: "nomic-embed-text  (768-dim, fast, good quality)", hint: "recommended" },
            { value: "mxbai-embed-large", label: "mxbai-embed-large  (1024-dim, higher quality, slower)" },
            { value: "custom", label: "Custom model name" },
        ],
    });
    checkCancel(modelChoice);

    if (modelChoice === "custom") {
        const custom = await p.text({ message: "Model name (as shown in `ollama list`)" });
        checkCancel(custom);
        embedModel = custom as string;
    } else {
        embedModel = modelChoice as string;
    }

    // Start Docker containers (with semantic profile if using Docker Ollama)
    const profile = ollamaMode === "docker" ? "--profile semantic" : "";
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

    // Wait for Ollama to be ready
    if (ollamaMode === "docker" || ollamaMode === "local") {
        const s = p.spinner();
        s.start(`Waiting for Ollama at ${ollamaUrl}`);
        const ready = await waitForHttp(`${ollamaUrl}/api/tags`, ollamaMode === "docker" ? 60_000 : 10_000);
        if (!ready) {
            s.error("Ollama did not respond in time");
            if (ollamaMode === "local") {
                p.log.warn("Make sure Ollama is running: `ollama serve`");
            }
            const cont = await p.confirm({ message: "Continue anyway (skip embedding setup)?" });
            checkCancel(cont);
            if (!cont) process.exit(1);
        } else {
            s.stop("Ollama is ready");
            // Pull the model
            const s2 = p.spinner();
            s2.start(`Pulling model ${embedModel} (may take a few minutes on first run)`);
            const ok = await pullOllamaModel(ollamaUrl, embedModel);
            s2.stop(ok ? `Model ${embedModel} ready` : `Pull may not have completed — check with: docker exec modlens-ollama ollama list`);
        }
    }
} else {
    // No semantic — just start postgres
    const s = p.spinner();
    s.start("Starting PostgreSQL container");
    const up = run("docker compose up -d");
    if (!up.ok) {
        s.error("Failed to start container");
        p.log.error(up.out);
        process.exit(1);
    }
    s.stop("PostgreSQL container started");
}

// ── Step 3: Wait for Postgres ─────────────────────────────────────────────────
{
    const s = p.spinner();
    s.start("Waiting for PostgreSQL to be healthy");
    const ready = await waitForHttp("http://localhost:5433", 30_000).catch(() => false);
    // pg_isready is more reliable than HTTP
    let healthy = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const r = run("docker exec modlens-postgres pg_isready -U modlens", { silent: true });
        if (r.ok) { healthy = true; break; }
        await new Promise(r2 => setTimeout(r2, 1000));
    }
    s.stop(healthy ? "PostgreSQL is ready" : "PostgreSQL health check timed out — continuing anyway");
}

// ── Step 4: Write .env ────────────────────────────────────────────────────────
{
    const existing = readEnv();
    const env: Record<string, string> = {
        DATABASE_URL: existing.DATABASE_URL ?? "postgresql://modlens:modlens@localhost:5433/modlens",
        ...(wantSemantic ? {
            OLLAMA_URL: ollamaUrl,
            OLLAMA_EMBED_MODEL: embedModel,
        } : {}),
    };

    // Preserve any existing API keys
    if (existing.CURSEFORGE_API_KEY) env.CURSEFORGE_API_KEY = existing.CURSEFORGE_API_KEY;
    if (existing.MODRINTH_TOKEN)     env.MODRINTH_TOKEN     = existing.MODRINTH_TOKEN;

    writeEnv(env);
    p.log.success(".env written");
}

// ── Step 5: Prisma schema ─────────────────────────────────────────────────────
{
    const s = p.spinner();
    s.start("Applying database schema (prisma db push)");
    const r = run("npx prisma db push --skip-generate", { silent: true });
    if (!r.ok) {
        s.error("prisma db push failed");
        p.log.error(r.out.slice(0, 500));
        process.exit(1);
    }
    s.stop("Database schema applied");
}

// ── Step 6: pgvector + embedding columns ─────────────────────────────────────
if (wantSemantic) {
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

// ── Step 7: Seed + backfill ───────────────────────────────────────────────────
const wantSeed = await p.confirm({
    message: "Seed default documentation and migration primers?",
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
    } catch (e) {
        s.stop("Seed had warnings (data may already exist — that is fine)");
    }
}

if (wantSemantic) {
    const wantBackfill = await p.confirm({
        message: "Embed existing docs and primers now for semantic search?",
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

// ── Step 8: MCP client config ─────────────────────────────────────────────────
const serverPath = join(ROOT, "dist", "server.js").replace(/\\/g, "/");
const envVars: Record<string, string> = {
    DATABASE_URL: "postgresql://modlens:modlens@localhost:5433/modlens",
    ...(wantSemantic ? { OLLAMA_URL: ollamaUrl, OLLAMA_EMBED_MODEL: embedModel } : {}),
};

const mcpClient = await p.select({
    message: "Configure MCP client?",
    options: [
        { value: "vscode",   label: "VS Code (user-level mcp.json)" },
        { value: "claude",   label: "Claude Desktop" },
        { value: "show",     label: "Show config snippet — I'll add it myself" },
        { value: "skip",     label: "Skip" },
    ],
});
checkCancel(mcpClient);

const vscodeEntry = {
    type: "stdio",
    command: "node",
    args: [serverPath],
    env: envVars,
};

const claudeEntry = {
    command: "node",
    args: [serverPath],
    env: envVars,
};

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

// ── Done ──────────────────────────────────────────────────────────────────────
p.outro(
    wantSemantic
        ? "modlens is ready with semantic search! Restart your MCP client to pick up the server."
        : "modlens is ready! Restart your MCP client to pick up the server.",
);

await disconnect();
