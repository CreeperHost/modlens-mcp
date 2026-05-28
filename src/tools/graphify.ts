import { spawn, execFile } from "child_process";
import { join } from "path";
import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import { createHash } from "crypto";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { paths, exists, ensureDir } from "../cache.js";
import { findModById, updateMod } from "../repositories/mod.js";
import { validateDbId } from "../validate.js";

const graphSentinelDone = (dir: string) => join(dir, ".graph.done");
const graphSentinelErr = (dir: string) => join(dir, ".graph.error");
const graphRunning = (dir: string) => join(dir, ".graph.running");
const enrichCursorFile = (graphDir: string) => join(graphDir, ".graph.enrich-cursor");

let graphifyCli: string | null | undefined; // undefined = not checked yet

// ── Backend detection ─────────────────────────────────────────────────────────

/** Per-1M-token pricing for cloud backends */
const BACKEND_PRICING: Record<string, { input: number; output: number }> = {
    gemini:   { input: 0.50, output: 3.00 },
    openai:   { input: 0.40, output: 1.60 },
    claude:   { input: 3.00, output: 15.00 },
    deepseek: { input: 0.14, output: 0.28 },
    kimi:     { input: 0.74, output: 4.66 },
    ollama:   { input: 0, output: 0 },
    custom:   { input: 0, output: 0 },
};

const BACKEND_DEFAULT_MODELS: Record<string, string> = {
    gemini:   "gemini-3-flash-preview",
    openai:   "gpt-4.1-mini",
    claude:   "claude-sonnet-4-6",
    deepseek: "deepseek-v4-flash",
    kimi:     "kimi-k2.6",
    ollama:   "qwen2.5-coder:7b",
};

/** Model preference order for Ollama generation model detection */
const OLLAMA_MODEL_PREFERENCE = [
    "qwen2.5-coder:14b",
    "qwen2.5-coder:7b",
    "qwen3:8b",
    "qwen2.5-coder:3b",
];

export interface DetectedBackend {
    backend: string;
    model: string;
    pricing: { input: number; output: number };
}

let cachedOllamaModel: { model: string; contextLength: number; params: string } | null | undefined;

/**
 * Detect the best available Ollama generation model.
 * Returns null if no suitable model found or Ollama unreachable.
 */
export async function detectOllamaModel(): Promise<{ model: string; contextLength: number; params: string } | null> {
    if (cachedOllamaModel !== undefined) return cachedOllamaModel;

    const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
    try {
        const res = await fetch(`${ollamaUrl}/api/tags`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) { cachedOllamaModel = null; return null; }

        const data = await res.json() as { models?: Array<{ name: string; details?: { parameter_size?: string; family?: string }; size?: number }> };
        const models = data.models ?? [];
        const modelNames = models.map(m => m.name);

        // Check preference order first
        for (const pref of OLLAMA_MODEL_PREFERENCE) {
            const match = modelNames.find(n => n === pref || n.startsWith(pref));
            if (match) {
                const m = models.find(mod => mod.name === match)!;
                cachedOllamaModel = {
                    model: match,
                    contextLength: 32768,
                    params: m.details?.parameter_size ?? "unknown",
                };
                return cachedOllamaModel;
            }
        }

        // Fallback: any model with "coder" in name
        const coderModel = models.find(m => m.name.toLowerCase().includes("coder"));
        if (coderModel) {
            cachedOllamaModel = {
                model: coderModel.name,
                contextLength: 32768,
                params: coderModel.details?.parameter_size ?? "unknown",
            };
            return cachedOllamaModel;
        }

        // Fallback: any model >= 7B (by name heuristic — look for :7b, :8b, :14b etc.)
        const largeModel = models.find(m => {
            const sizeMatch = m.name.match(/:(\d+)b/i);
            return sizeMatch && parseInt(sizeMatch[1]) >= 7;
        });
        if (largeModel) {
            cachedOllamaModel = {
                model: largeModel.name,
                contextLength: 32768,
                params: largeModel.details?.parameter_size ?? "unknown",
            };
            return cachedOllamaModel;
        }

        cachedOllamaModel = null;
        return null;
    } catch {
        cachedOllamaModel = null;
        return null;
    }
}

/**
 * Detect the best available backend for graphify semantic extraction.
 * Checks explicit config, cloud API keys, then Ollama.
 */
export async function detectBackend(): Promise<DetectedBackend | null> {
    const explicit = process.env.GRAPHIFY_BACKEND;
    const explicitModel = process.env.GRAPHIFY_MODEL;

    // Explicit backend set
    if (explicit && explicit !== "ast-only") {
        if (explicit === "custom") {
            const baseUrl = process.env.GRAPHIFY_CUSTOM_BASE_URL;
            const apiKey = process.env.GRAPHIFY_CUSTOM_API_KEY;
            if (!baseUrl || !apiKey) return null;
            return {
                backend: "custom",
                model: explicitModel ?? process.env.GRAPHIFY_CUSTOM_MODEL ?? "gpt-4.1-mini",
                pricing: { input: 0, output: 0 },
            };
        }
        return {
            backend: explicit,
            model: explicitModel ?? BACKEND_DEFAULT_MODELS[explicit] ?? "unknown",
            pricing: BACKEND_PRICING[explicit] ?? { input: 0, output: 0 },
        };
    }

    if (explicit === "ast-only") return null;

    // Auto-detect from API keys (priority order)
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
        return { backend: "gemini", model: explicitModel ?? "gemini-3-flash-preview", pricing: BACKEND_PRICING.gemini };
    }
    if (process.env.DEEPSEEK_API_KEY) {
        return { backend: "deepseek", model: explicitModel ?? "deepseek-v4-flash", pricing: BACKEND_PRICING.deepseek };
    }
    if (process.env.OPENAI_API_KEY) {
        return { backend: "openai", model: explicitModel ?? "gpt-4.1-mini", pricing: BACKEND_PRICING.openai };
    }
    if (process.env.ANTHROPIC_API_KEY) {
        return { backend: "claude", model: explicitModel ?? "claude-sonnet-4-6", pricing: BACKEND_PRICING.claude };
    }
    if (process.env.MOONSHOT_API_KEY) {
        return { backend: "kimi", model: explicitModel ?? "kimi-k2.6", pricing: BACKEND_PRICING.kimi };
    }
    if (process.env.GRAPHIFY_CUSTOM_BASE_URL && process.env.GRAPHIFY_CUSTOM_API_KEY) {
        return {
            backend: "custom",
            model: explicitModel ?? process.env.GRAPHIFY_CUSTOM_MODEL ?? "gpt-4.1-mini",
            pricing: { input: 0, output: 0 },
        };
    }

    // Ollama with generation model
    const ollamaModel = await detectOllamaModel();
    if (ollamaModel) {
        return { backend: "ollama", model: ollamaModel.model, pricing: BACKEND_PRICING.ollama };
    }

    return null;
}

/**
 * Estimate extraction cost for a cloud backend.
 */
function estimateCost(sourceFileCount: number, pricing: { input: number; output: number }): string {
    if (pricing.input === 0 && pricing.output === 0) return "$0.00";
    // Rough estimate: ~200 tokens per file input, ~100 tokens per file output
    const inputTokens = sourceFileCount * 200;
    const outputTokens = sourceFileCount * 100;
    const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
    return `$${cost.toFixed(3)}`;
}

/**
 * Check if `graphify` CLI is available. Returns the command name or throws.
 * Caches result for the process lifetime.
 */
export async function ensureGraphify(): Promise<string> {
    if (graphifyCli !== undefined) {
        if (graphifyCli === null) throw new Error(
            "graphify CLI not found. Install with: uv tool install graphifyy"
        );
        return graphifyCli;
    }

    for (const cmd of ["graphify", "python", "python3"]) {
        const args = cmd === "graphify" ? ["--version"] : ["-m", "graphify", "--version"];
        try {
            await new Promise<void>((resolve, reject) => {
                execFile(cmd, args, { timeout: 5000 },
                    (err) => err ? reject(err) : resolve());
            });
            graphifyCli = cmd === "graphify" ? cmd : `${cmd} -m graphify`;
            return graphifyCli;
        } catch { /* try next */ }
    }
    graphifyCli = null;
    throw new Error("graphify CLI not found. Install with: uv tool install graphifyy");
}

async function isGraphDone(graphDir: string, extraGraphJsonPaths?: string[]): Promise<"done" | "error" | "running" | "not_started"> {
    if (await exists(graphSentinelDone(graphDir))) return "done";
    if (await exists(graphSentinelErr(graphDir))) return "error";
    // Fallback: check if graph.json exists (in case sentinel was missed)
    if (await exists(join(graphDir, "graphify-out", "graph.json"))) return "done";
    if (extraGraphJsonPaths) {
        for (const p of extraGraphJsonPaths) {
            if (await exists(join(p, "graph.json"))) return "done";
        }
    }
    if (await exists(graphRunning(graphDir))) return "running";
    return "not_started";
}

/** Find the first directory that contains graph.json */
async function findGraphOutput(graphDir: string, extra: string[]): Promise<string | null> {
    const legacy = join(graphDir, "graphify-out");
    if (await exists(join(legacy, "graph.json"))) return legacy;
    for (const p of extra) {
        if (await exists(join(p, "graph.json"))) return p;
    }
    return null;
}

/**
 * Build a knowledge graph for a mod. Prefers downloaded source (has docs/comments)
 * over decompiled source (bare Java). Spawns graphify in background.
 * When a semantic backend is available, uses `extract` for richer graphs.
 */
export async function buildModGraph(
    dbId: number,
    force = false,
    backendOverride?: string,
): Promise<{ status: string; graphDir: string; sourceType: string; message: string; backend?: string; estimatedCost?: string; hint?: string }> {
    validateDbId(dbId);
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const graphDir = paths.graphs(mod.modId, mod.version);
    await mkdir(graphDir, { recursive: true });

    // Possible output locations: source dir or decomp dir (graphify writes graphify-out/ inside the target)
    const candidateGraphPaths = [
        mod.sourcePath ? join(mod.sourcePath, "graphify-out") : null,
        mod.decompPath ? join(mod.decompPath, "graphify-out") : null,
    ].filter(Boolean) as string[];

    // Check existing state
    if (!force) {
        const state = await isGraphDone(graphDir, candidateGraphPaths);
        if (state === "done") {
            // Find the actual output dir
            const outDir = await findGraphOutput(graphDir, candidateGraphPaths);
            if (outDir) await updateMod(dbId, { graphPath: outDir });
            return { status: "done", graphDir: outDir ?? graphDir, sourceType: "cached", message: "Graph already built. Use graph_query to search it." };
        }
        if (state === "running") {
            return { status: "running", graphDir, sourceType: "unknown", message: "Graph build in progress. Poll graph_status to check." };
        }
    }

    // Pick the best source directory — authored source preferred over decompiled
    let sourceDir: string;
    let sourceType: string;
    if (mod.sourcePath && await exists(mod.sourcePath)) {
        sourceDir = mod.sourcePath;
        sourceType = "source";
    } else if (mod.decompPath && await exists(mod.decompPath)) {
        sourceDir = mod.decompPath;
        sourceType = "decompiled";
    } else {
        throw new Error(
            `No source available for mod #${dbId} (${mod.modId}). ` +
            `Decompile first (mod action=decompile) or download source (platform action=download_source).`
        );
    }

    const cli = await ensureGraphify();

    // Clean stale sentinels (stored alongside source dir)
    await unlink(graphSentinelDone(graphDir)).catch(() => {});
    await unlink(graphSentinelErr(graphDir)).catch(() => {});
    await unlink(graphRunning(graphDir)).catch(() => {});

    // Write running indicator
    await writeFile(graphRunning(graphDir), String(Date.now()));

    // Detect backend for semantic extraction
    let resolved: DetectedBackend | null = null;
    let hint: string | undefined;
    if (backendOverride === "ast-only") {
        // Force AST-only
    } else if (backendOverride) {
        resolved = {
            backend: backendOverride,
            model: process.env.GRAPHIFY_MODEL ?? BACKEND_DEFAULT_MODELS[backendOverride] ?? "unknown",
            pricing: BACKEND_PRICING[backendOverride] ?? { input: 0, output: 0 },
        };
    } else {
        resolved = await detectBackend();
    }

    // Build graphify command and env
    const outDir = join(sourceDir, "graphify-out");
    const extraEnv: Record<string, string> = {};
    let args: string[];

    if (resolved) {
        // Semantic extraction via LLM
        args = ["extract", sourceDir, "--no-viz"];

        if (resolved.backend === "custom") {
            // Route through openai backend with custom base URL
            extraEnv.OPENAI_API_KEY = process.env.GRAPHIFY_CUSTOM_API_KEY!;
            extraEnv.OPENAI_BASE_URL = process.env.GRAPHIFY_CUSTOM_BASE_URL!;
            args.push("--backend", "openai", "--model", resolved.model);
        } else if (resolved.backend === "ollama") {
            const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
            extraEnv.OLLAMA_BASE_URL = `${ollamaUrl}/v1`;
            extraEnv.OLLAMA_MODEL = resolved.model;
            extraEnv.GRAPHIFY_OLLAMA_KEEP_ALIVE = "30m";
            args.push("--backend", "ollama", "--max-concurrency", "1");
        } else {
            args.push("--backend", resolved.backend);
            if (process.env.GRAPHIFY_MODEL) {
                args.push("--model", process.env.GRAPHIFY_MODEL);
            }
            // Cloud backends can handle parallel requests
            args.push("--max-concurrency", "4");
        }
        args.push("--token-budget", "30000");
    } else {
        // AST-only extraction (tree-sitter) — no LLM needed
        args = ["update", sourceDir, "--no-cluster"];

        // Check if Ollama is up but has no generation model — give a hint
        const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
        try {
            const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) {
                hint = "For richer graphs with semantic relationships, pull a coder model: ollama pull qwen2.5-coder:7b (~4.7GB)";
            }
        } catch { /* Ollama not reachable — fine */ }
    }

    // Spawn detached — same pattern as Vineflower in java-tools.ts
    const cmdParts = cli.split(" ");
    const proc = spawn(cmdParts[0], [...cmdParts.slice(1), ...args], {
        stdio: "ignore",
        detached: true,
        cwd: graphDir,
        env: { ...process.env, ...extraEnv },
    });
    proc.unref();

    // Background sentinel writer — NOT awaited by caller
    (async () => {
        await new Promise<void>((resolve) => {
            proc.on("close", async (code) => {
                await unlink(graphRunning(graphDir)).catch(() => {});
                const sentinel = code === 0
                    ? graphSentinelDone(graphDir)
                    : graphSentinelErr(graphDir);
                await writeFile(sentinel, String(code ?? "signal")).catch(() => {});
                if (code === 0) {
                    await updateMod(dbId, { graphPath: outDir }).catch(() => {});
                }
                resolve();
            });
            proc.on("error", async () => {
                await unlink(graphRunning(graphDir)).catch(() => {});
                await writeFile(graphSentinelErr(graphDir), "spawn-error").catch(() => {});
                resolve();
            });
        });
    })();

    // Brief wait to confirm spawn
    await new Promise<void>((res) => setTimeout(res, 300));

    const mode = resolved ? `semantic (${resolved.backend}/${resolved.model})` : "AST-only";
    const cost = resolved ? estimateCost(100, resolved.pricing) : undefined;

    return {
        status: "started",
        graphDir: outDir,
        sourceType,
        backend: resolved?.backend ?? "ast-only",
        estimatedCost: cost,
        hint,
        message: `Graphify building ${mode} graph of ${sourceType} source for ${mod.modId}. Poll graph_status to check progress.`,
    };
}

export async function graphBuildStatus(
    dbId: number,
): Promise<{ status: string; graphDir: string; message: string }> {
    validateDbId(dbId);
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const graphDir = paths.graphs(mod.modId, mod.version);
    const candidateGraphPaths = [
        mod.sourcePath ? join(mod.sourcePath, "graphify-out") : null,
        mod.decompPath ? join(mod.decompPath, "graphify-out") : null,
    ].filter(Boolean) as string[];
    const state = await isGraphDone(graphDir, candidateGraphPaths);

    switch (state) {
        case "done": {
            const outDir = await findGraphOutput(graphDir, candidateGraphPaths);
            if (outDir && !mod.graphPath) {
                await updateMod(dbId, { graphPath: outDir });
            }
            return { status: "done", graphDir: outDir ?? graphDir, message: "Graph ready. Use graph_query to search it." };
        }
        case "error":
            return { status: "error", graphDir, message: "Graphify exited with an error. Check .graph.error sentinel." };
        case "running":
            return { status: "running", graphDir, message: "Graph build still running..." };
        default:
            return { status: "not_started", graphDir, message: "No graph build found. Use graph_build to start one." };
    }
}

/**
 * Query a mod's knowledge graph. Returns a compact subgraph (~500 tokens)
 * instead of raw source files (~10-50K tokens).
 */
export async function queryModGraph(
    dbId: number,
    query: string,
    budget?: number,
): Promise<{ answer: string; graphUsed: boolean; hint: string }> {
    validateDbId(dbId);
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const graphPath = mod.graphPath;
    if (!graphPath || !await exists(join(graphPath, "graph.json"))) {
        return {
            answer: `No graph available for ${mod.modId}. Build one first with: mod action=graph_build modId="${mod.modId}"`,
            graphUsed: false,
            hint: "Use mod action=source to browse raw source files instead.",
        };
    }

    const cli = await ensureGraphify();
    const cmdParts = cli.split(" ");
    const args = [
        ...cmdParts.slice(1),
        "query", query,
        "--graph", join(graphPath, "graph.json"),
        "--budget", String(budget ?? 2000),
    ];

    const result = await new Promise<string>((resolve, reject) => {
        execFile(cmdParts[0], args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`graphify query failed: ${stderr || err.message}`));
            else resolve(stdout);
        });
    });

    return {
        answer: result.trim(),
        graphUsed: true,
        hint: "For full source of specific files mentioned above, use: mod action=source dbId=<id> path=<file>",
    };
}

/**
 * Return the GRAPH_REPORT.md for a mod — contains god nodes, surprising
 * connections, and suggested questions. Much cheaper than reading source.
 */
export async function getGraphReport(dbId: number): Promise<string> {
    validateDbId(dbId);
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const graphPath = mod.graphPath;
    if (!graphPath) throw new Error(`No graph for ${mod.modId}. Run graph_build first.`);

    const reportPath = join(graphPath, "GRAPH_REPORT.md");
    if (!await exists(reportPath)) throw new Error("GRAPH_REPORT.md not found in graph output.");

    const content = await readFile(reportPath, "utf8");
    return content.slice(0, 30_000); // cap at 30KB (reports are typically 2-5KB)
}

// ── Graph enrichment (Plan 1: Chat-Agent-Driven) ──────────────────────────────

const ENRICHMENT_SCHEMA = `Return JSON with this exact structure:
{
  "nodes": [{"id": "ClassName", "type": "class", "src": "path/to/File.java", "loc": "L42", "community": "subsystem_name"}],
  "edges": [{"source": "ClassA", "target": "ClassB", "relation": "implements_pattern", "context": "Singleton pattern via lazy init"}]
}

Valid relation types for semantic edges: implements_pattern, belongs_to_subsystem, delegates_to, adapts, wraps, event_handler_for, config_for, registry_entry, extends_behavior.
Node types: class, interface, enum, annotation, package, subsystem.
Focus on design patterns, subsystem groupings, and architectural relationships — NOT call graphs (those are already in the AST layer).`;

const CHUNK_SIZE = 20; // files per chunk

interface GraphJson {
    nodes: Array<{ id: string; type?: string; src?: string; loc?: string; community?: string; [k: string]: unknown }>;
    edges: Array<{ source: string; target: string; relation?: string; context?: string; [k: string]: unknown }>;
}

/**
 * Return the next un-enriched chunk of source files for the chat agent to process.
 */
export async function enrichNextChunk(
    dbId: number,
): Promise<{ chunkIndex: number; totalChunks: number; prompt: string; schema: string; done: boolean }> {
    validateDbId(dbId);
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const graphPath = mod.graphPath;
    if (!graphPath || !await exists(join(graphPath, "graph.json"))) {
        throw new Error(`No graph for ${mod.modId}. Run graph_build first.`);
    }

    // Read existing graph
    const graph: GraphJson = JSON.parse(await readFile(join(graphPath, "graph.json"), "utf8"));

    // Collect source files from nodes
    const sourceFiles = [...new Set(graph.nodes.map(n => n.src).filter(Boolean))] as string[];
    const totalChunks = Math.max(1, Math.ceil(sourceFiles.length / CHUNK_SIZE));

    // Read cursor
    let cursor = 0;
    const cursorPath = enrichCursorFile(graphPath);
    if (await exists(cursorPath)) {
        cursor = parseInt(await readFile(cursorPath, "utf8"), 10) || 0;
    }

    if (cursor >= totalChunks) {
        return { chunkIndex: cursor, totalChunks, prompt: "", schema: "", done: true };
    }

    // Get chunk files
    const chunkFiles = sourceFiles.slice(cursor * CHUNK_SIZE, (cursor + 1) * CHUNK_SIZE);

    // Build prompt with AST context for these files
    const nodesInChunk = graph.nodes.filter(n => n.src && chunkFiles.includes(n.src));
    const edgesInChunk = graph.edges.filter(e =>
        nodesInChunk.some(n => n.id === e.source || n.id === e.target)
    );

    const astContext = {
        files: chunkFiles,
        existingNodes: nodesInChunk.map(n => ({ id: n.id, type: n.type, src: n.src })),
        existingEdges: edgesInChunk.map(e => ({ source: e.source, target: e.target, relation: e.relation })),
    };

    const prompt = `Analyze these ${chunkFiles.length} source files from mod "${mod.modId}" and identify semantic relationships.

AST context (structural relationships already captured):
${JSON.stringify(astContext, null, 2)}

Add SEMANTIC relationships on top — design patterns, subsystem groupings, architectural intent.
Do NOT duplicate existing structural edges (calls, imports, extends, implements).`;

    return {
        chunkIndex: cursor,
        totalChunks,
        prompt,
        schema: ENRICHMENT_SCHEMA,
        done: false,
    };
}

/**
 * Merge the chat agent's semantic response back into graph.json.
 */
export async function submitEnrichment(
    dbId: number,
    chunkIndex: number,
    nodes: Array<{ id: string; [k: string]: unknown }>,
    edges: Array<{ source: string; target: string; relation: string; [k: string]: unknown }>,
): Promise<{ merged: { newNodes: number; newEdges: number }; nextChunk: number; totalChunks: number }> {
    validateDbId(dbId);
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    const graphPath = mod.graphPath;
    if (!graphPath || !await exists(join(graphPath, "graph.json"))) {
        throw new Error(`No graph for ${mod.modId}. Run graph_build first.`);
    }

    // Validate submitted data
    const { validateGraphEntries } = await import("../security.js");
    const validation = validateGraphEntries(nodes, edges);
    if (!validation.valid) {
        throw new Error(`Enrichment validation failed: ${validation.reason}. ${validation.flaggedEntries?.length ? `Flagged: ${validation.flaggedEntries.join(", ")}` : ""}`);
    }

    // Read existing graph
    const graph: GraphJson = JSON.parse(await readFile(join(graphPath, "graph.json"), "utf8"));

    // Merge nodes (deduplicate by id)
    const existingIds = new Set(graph.nodes.map(n => n.id));
    let newNodes = 0;
    for (const node of nodes) {
        if (!existingIds.has(node.id)) {
            graph.nodes.push(node as GraphJson["nodes"][0]);
            existingIds.add(node.id);
            newNodes++;
        }
    }

    // Append edges
    let newEdges = 0;
    for (const edge of edges) {
        if (!edge.source || !edge.target || !edge.relation) continue;
        graph.edges.push(edge as GraphJson["edges"][0]);
        newEdges++;
    }

    // Write updated graph
    await writeFile(join(graphPath, "graph.json"), JSON.stringify(graph, null, 2));

    // Advance cursor
    const sourceFiles = [...new Set(graph.nodes.map(n => n.src).filter(Boolean))];
    const totalChunks = Math.max(1, Math.ceil(sourceFiles.length / CHUNK_SIZE));
    const nextChunk = chunkIndex + 1;
    await writeFile(enrichCursorFile(graphPath), String(nextChunk));

    return { merged: { newNodes, newEdges }, nextChunk, totalChunks };
}

// ── Graph registry download (Plan 1) ─────────────────────────────────────────

const GRAPH_REGISTRY_URL = process.env.MODLENS_GRAPH_REGISTRY_URL ??
    "https://raw.githubusercontent.com/Mattabase/modlens-graphs/main/index.json";

interface GraphRegistryEntry {
    targetType?: "mod" | "vanilla" | "modloader";
    targetId?: string;
    targetVersion?: string;
    modId: string;
    version: string;
    loader: string;
    mcVersion: string;
    backend?: string;
    model?: string;
    graphUrl: string;
    sha256: string;
    nodeCount: number;
    edgeCount: number;
    enriched: boolean;
    updatedAt: string;
}

interface GraphRegistry {
    version: number;
    graphs: GraphRegistryEntry[];
}

type GraphTargetType = "mod" | "vanilla" | "modloader";

type DownloadGraphRequest = {
    targetType?: GraphTargetType;
    dbId?: number;
    targetId?: string;
    targetVersion?: string;
    loader?: string;
    mcVersion?: string;
};

let cachedRegistry: { data: GraphRegistry; fetchedAt: number } | null = null;
const REGISTRY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchGraphRegistry(): Promise<GraphRegistry> {
    if (cachedRegistry && Date.now() - cachedRegistry.fetchedAt < REGISTRY_CACHE_TTL) {
        return cachedRegistry.data;
    }

    const res = await fetch(GRAPH_REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) {
        const empty: GraphRegistry = { version: 1, graphs: [] };
        cachedRegistry = { data: empty, fetchedAt: Date.now() };
        return empty;
    }
    if (!res.ok) throw new Error(`Failed to fetch graph registry: ${res.status}`);

    const data = await res.json() as GraphRegistry;
    if (!data.version || !Array.isArray(data.graphs)) {
        throw new Error("Invalid graph registry format");
    }

    cachedRegistry = { data, fetchedAt: Date.now() };
    return data;
}

/**
 * Download a pre-built graph from the public registry.
 */
export async function downloadGraph(
    reqOrDbId: number | DownloadGraphRequest,
): Promise<{
    status: string;
    source?: string;
    nodeCount?: number;
    edgeCount?: number;
    enriched?: boolean;
    backend?: string;
    model?: string;
    targetType?: "mod" | "vanilla" | "modloader";
}> {
    const req: DownloadGraphRequest = typeof reqOrDbId === "number"
        ? { targetType: "mod", dbId: reqOrDbId }
        : reqOrDbId;

    const targetType: GraphTargetType = req.targetType ?? "mod";

    let resolvedTargetId = req.targetId ?? "";
    let resolvedTargetVersion = req.targetVersion ?? "";
    let installDir = "";
    let modDbIdForUpdate: number | null = null;

    if (targetType === "mod") {
        if (req.dbId != null) {
            validateDbId(req.dbId);
            const mod = await findModById(req.dbId);
            if (!mod) throw new Error(`Mod #${req.dbId} not found`);
            resolvedTargetId = resolvedTargetId || mod.modId;
            resolvedTargetVersion = resolvedTargetVersion || mod.version;
            installDir = mod.sourcePath
                ? join(mod.sourcePath, "graphify-out")
                : mod.decompPath
                    ? join(mod.decompPath, "graphify-out")
                    : paths.graphs(mod.modId, mod.version);
            modDbIdForUpdate = mod.id;
        } else {
            if (!resolvedTargetId || !resolvedTargetVersion) {
                throw new Error("graph_download targetType=mod requires dbId or targetId+targetVersion");
            }
            installDir = join(paths.graphs("mod", "external"), resolvedTargetId, resolvedTargetVersion);
        }
    } else {
        if (!resolvedTargetId || !resolvedTargetVersion) {
            throw new Error("graph_download for vanilla/modloader requires targetId and targetVersion");
        }
        installDir = join(paths.graphs(targetType, "external"), resolvedTargetId, resolvedTargetVersion);
    }

    let registry: GraphRegistry;
    try {
        registry = await fetchGraphRegistry();
    } catch (e) {
        return { status: "registry_unavailable", source: (e as Error).message };
    }

    // Find matching entry
    const entry = registry.graphs.find((g) => {
        const regType = g.targetType ?? "mod";
        const regId = g.targetId ?? g.modId;
        const regVersion = g.targetVersion ?? g.version;
        return regType === targetType
            && regId === resolvedTargetId
            && regVersion === resolvedTargetVersion;
    });
    if (!entry) {
        return { status: "not_found" };
    }

    // Resolve URL (relative URLs are relative to registry base)
    let graphUrl = entry.graphUrl;
    if (!graphUrl.startsWith("http")) {
        const base = GRAPH_REGISTRY_URL.substring(0, GRAPH_REGISTRY_URL.lastIndexOf("/") + 1);
        graphUrl = base + graphUrl;
    }

    // Validate URL scheme
    if (!graphUrl.startsWith("https://")) {
        throw new Error("Graph URL must use HTTPS");
    }

    // Download
    const res = await fetch(graphUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Failed to download graph: ${res.status}`);

    const contentLength = parseInt(res.headers.get("content-length") ?? "0");
    if (contentLength > 100_000_000) {
        throw new Error("Graph file too large (>100MB)");
    }

    const graphData = await res.text();

    // Verify SHA-256
    const hash = createHash("sha256").update(graphData).digest("hex");
    if (hash !== entry.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${entry.sha256}, got ${hash}`);
    }

    // Parse and validate
    const graphJson = JSON.parse(graphData) as GraphJson;
    const { validateGraphBundle } = await import("../security.js");
    const validation = validateGraphBundle(graphJson);
    if (!validation.valid) {
        throw new Error(`Graph validation failed: ${validation.reason}`);
    }

    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, "graph.json"), graphData);
    if (modDbIdForUpdate != null) {
        await updateMod(modDbIdForUpdate, { graphPath: installDir });
    }

    return {
        status: "downloaded",
        source: "registry",
        nodeCount: entry.nodeCount,
        edgeCount: entry.edgeCount,
        enriched: entry.enriched,
        backend: entry.backend,
        model: entry.model,
        targetType: entry.targetType ?? "mod",
    };
}
