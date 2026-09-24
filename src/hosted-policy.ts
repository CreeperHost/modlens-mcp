import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getDb } from "./db.js";
import { guardHostedMod, attachLicenseNotices } from "./hosted-mod-license.js";

export interface HostedLimits {
    lines: number;
    responseBytes: number;
    dailyBytes: number;
    periodBytes: number;
    dailyRequests: number;
    minuteRequests: number;
}

export function hostedLimits(env: NodeJS.ProcessEnv = process.env): HostedLimits {
    const number = (key: string, fallback: number) => {
        if (env[key] === undefined) return fallback;
        const value = Number(env[key]);
        if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
            throw new Error(`${key} must be a positive integer no larger than 1000000000`);
        }
        return value;
    };
    return {
        lines: number("MODLENS_HOSTED_SOURCE_LINES", 200),
        responseBytes: number("MODLENS_HOSTED_RESPONSE_BYTES", 128 * 1024),
        dailyBytes: number("MODLENS_HOSTED_DAILY_BYTES", 5 * 1024 * 1024),
        periodBytes: number("MODLENS_HOSTED_PERIOD_BYTES", 50 * 1024 * 1024),
        dailyRequests: number("MODLENS_HOSTED_DAILY_REQUESTS", 1000),
        minuteRequests: number("MODLENS_HOSTED_MINUTE_REQUESTS", 120),
    };
}

export class HostedPolicyError extends Error {}

/** Only an authenticated gateway may choose the stable account identifier. */
export function hostedPrincipal(headers: IncomingHttpHeaders, secret?: string): string {
    if (!secret) return "shared"; // Never trust user-supplied IDs, bearer tokens, IPs or session IDs.
    const provided = headers["x-modlens-proxy-secret"];
    const user = headers["x-modlens-user-id"];
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (typeof provided !== "string" || !timingSafeEqual(digest(provided), digest(secret))
        || typeof user !== "string" || !user.trim() || user.length > 256 || /[\r\n\x00]/.test(user)) {
        throw new HostedPolicyError("Authenticated gateway identity required.");
    }
    return digest(user).toString("hex");
}

/** Team claims are accepted only from the authenticated gateway. */
export function hostedMinecraftSourceTeams(env: NodeJS.ProcessEnv = process.env, secret?: string): Set<string> {
    if (env.MODLENS_HOSTED_MC_SOURCE !== "1") return new Set();
    if (!secret || secret.length < 32) throw new Error("MODLENS_HOSTED_MC_SOURCE requires MODLENS_HOSTED_PROXY_SECRET");
    const teams = (env.MODLENS_HOSTED_MC_SOURCE_TEAMS ?? "").split(",").map(value => value.trim()).filter(Boolean);
    if (!teams.length || teams.some(value => !/^[a-zA-Z0-9._:-]{1,128}$/.test(value))) {
        throw new Error("MODLENS_HOSTED_MC_SOURCE_TEAMS requires valid comma-separated team IDs");
    }
    return new Set(teams);
}

export function hostedMinecraftSourceAccess(headers: IncomingHttpHeaders, teams: ReadonlySet<string>): boolean {
    const team = headers["x-modlens-team-id"];
    return typeof team === "string" && teams.has(team);
}

// Fail closed: new tools/actions must be reviewed before becoming remotely available.
// Cache population and filesystem/registry administration stay on the operator's local interface.
export const HOSTED_ACTIONS: Record<string, readonly string[]> = {
    report_issue: ["help", "prepare"],
    runtime: ["help", "setup", "status", "sessions", "launch", "events", "command", "artifact"],
    mod_license: ["check", "local_plan"],
    mod: ["get", "search", "dependencies", "dep_graph", "version_conflicts", "source_urls", "decompile_class", "source", "search_source", "search_indexed", "search_semantic", "graph_query", "graph_report"],
    mod_bytecode: ["search_class", "class_members", "bytecode", "find_refs", "cross_refs", "inheritance", "diff", "diff_detailed", "find_implementors", "scan_registrations", "annotated_by", "event_listeners", "optional_integrations", "network_payloads", "config_schema"],
    mod_mixins: ["targets", "resolve", "conflicts", "targets_in_package", "at_conflicts", "at_entries", "aw_entries"],
    platform: ["search", "check_updates", "batch_check_updates"],
    modpacks_ch: ["search", "featured", "info", "manifest", "resolve_pack", "list_versions", "search_mods", "mod_info", "search_ftb_mods", "ftb_mod_info", "list_pack_versions", "list_pack_files", "find_mod_in_packs"],
    mc_versions: ["list_mc", "list_neoforge", "list_forge", "list_fabric"],
    mc_source: ["search_class", "source_info", "get_source", "bytecode", "class_members", "find_refs", "inheritance", "diff", "diff_detailed", "search_code", "search_indexed", "search_events", "validate_aw", "analyze_mixin", "search_semantic"],
    mappings: ["find", "parchment", "list_parchment", "parchment_summary"],
    docs: ["get", "search", "list", "semantic_search"],
    primers: ["get", "by_version", "search", "list", "semantic_search"],
    mc_registry: ["blocks", "commands", "registries", "sounds", "item_components", "registry_entries", "mcmeta_versions"],
    mc_data: ["tags", "find_tags_for", "recipes", "get_recipe", "find_recipes_for", "loot_tables", "get_loot_table", "lang", "blockstate", "model", "model_tree", "biomes", "get_biome", "damage_types", "enchantments", "get_enchantment", "advancements", "get_advancement", "structures", "get_structure", "particles", "get_particle", "entity_attributes"],
    mc_files: ["get_data", "get_asset", "list_files", "diff", "atlas", "compare", "changelog"],
    mod_jar: ["lang", "sounds", "atlas", "registry_entries", "manifest", "list_configs", "get_config"],
    mod_data: ["list", "get", "diff", "trace_item"],
    mod_tags: ["namespaces", "contributors", "expand", "mod_list", "find_conflicts", "search"],
    mixin_scan: ["list_mods", "conflict_matrix", "class_detail", "hotspots"],
    gradle: ["get_files", "search", "compare_deps"],
    project: ["upload_begin", "upload_chunk", "upload_finish", "upload_abort", "list", "info", "classes", "source", "search", "members", "bytecode"],
    reports: [""],
    pack_tools: ["asset_conflicts", "vanilla_overrides", "sidedness", "pack_sidedness", "complexity", "pack_changelog", "data_conflicts", "health"],
    analyze_crash_log: [""],
    find_missing_deps: [""],
};

export function hostedActions(tool: string, allowMinecraftSource = false): readonly string[] | undefined {
    const actions = HOSTED_ACTIONS[tool];
    if (tool !== "mc_source" || allowMinecraftSource) return actions;
    return actions.filter(action => action !== "get_source" && action !== "bytecode");
}

const rawSource = (tool: string, action: unknown) =>
    (tool === "mc_source" && ["get_source", "bytecode"].includes(String(action)))
    || (tool === "mod" && ["source", "decompile_class"].includes(String(action)))
    || (tool === "mod_bytecode" && action === "bytecode")
    || (tool === "project" && ["source", "bytecode"].includes(String(action)));

export function prepareHostedArgs(tool: string, input: Record<string, unknown>, limits: HostedLimits, allowMinecraftSource = false): Record<string, unknown> {
    const args = { ...input };
    if (!hostedActions(tool, allowMinecraftSource)?.includes(String(args.action ?? ""))) {
        throw new HostedPolicyError("This operation is available only to the server operator locally.");
    }
    if (tool === "project" && !allowMinecraftSource && ["source", "bytecode"].includes(String(args.action))
        && /^net[./]minecraft[./]/i.test(String(args.className ?? ""))) {
        throw new HostedPolicyError("Minecraft source is unavailable on public hosted access.");
    }
    if (args.savePath !== undefined || args.scriptsDir !== undefined || args.configDir !== undefined) {
        throw new HostedPolicyError("Host filesystem operations are unavailable remotely.");
    }
    if (tool === "mod_jar" && args.action === "get_config" && !/\.(?:json|json5|toml|cfg|conf|properties|ya?ml)$/i.test(String(args.path ?? ""))) {
        throw new HostedPolicyError("Specify a configuration file path.");
    }
    if (tool === "mc_files" && args.branch !== undefined && !["data", "assets", "registries", "summary", "diff", "atlas"].includes(String(args.branch))) {
        throw new HostedPolicyError("Unsupported data branch.");
    }
    for (const key of ["limit", "top", "budget"]) {
        if (args[key] !== undefined) {
            if (!Number.isSafeInteger(args[key]) || Number(args[key]) < 1) throw new HostedPolicyError(`${key} must be a positive integer.`);
            args[key] = Math.min(Number(args[key]), key === "budget" ? 2000 : 50);
        }
    }
    if (rawSource(tool, args.action)) {
        for (const key of ["startLine", "endLine", "maxLines"]) {
            if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < 1)) {
                throw new HostedPolicyError(`${key} must be a positive integer.`);
            }
        }
        const start = Number(args.startLine ?? 1);
        if (start > Number.MAX_SAFE_INTEGER - limits.lines) throw new HostedPolicyError("Invalid source range.");
        if (args.endLine !== undefined && Number(args.endLine) < start) throw new HostedPolicyError("Invalid source range.");
        args.startLine = start;
        args.maxLines = Math.min(Number(args.maxLines ?? limits.lines), limits.lines);
        if (args.endLine !== undefined) args.endLine = Math.min(Number(args.endLine), start + Number(args.maxLines) - 1);
    }
    // Keep exploration useful without unbounded empty searches / directory listings.
    if (tool === "mod" && args.action === "source" && !args.path) throw new HostedPolicyError("Specify a source file path or use a class search.");
    if ((String(args.action).startsWith("search") || args.action === "classes")
        && !(typeof args.query === "string" && args.query.trim())
        && !(typeof args.className === "string" && args.className.trim())) {
        throw new HostedPolicyError("Provide a focused search query.");
    }
    return args;
}

export interface BudgetDatabase {
    $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
    $queryRawUnsafe<T>(query: string, ...values: any[]): Promise<T>;
}

/** Atomic shared-database accounting: session churn, parallel calls and restarts do not reset it. */
export class HostedBudget {
    private ready?: Promise<void>;
    constructor(private database: () => Promise<BudgetDatabase> = getDb, private now = Date.now) {}

    async charge(subject: string, limits: HostedLimits, requests: number, bytes: number): Promise<void> {
        const db = await this.database();
        if (!this.ready) this.ready = db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hosted_usage (
            subject TEXT PRIMARY KEY, minute BIGINT NOT NULL, minute_requests BIGINT NOT NULL,
            day BIGINT NOT NULL, daily_requests BIGINT NOT NULL, daily_bytes BIGINT NOT NULL,
            period BIGINT NOT NULL, period_bytes BIGINT NOT NULL
        )`).then(() => {}).catch(e => { this.ready = undefined; throw e; });
        await this.ready;
        const time = this.now();
        const minute = Math.floor(time / 60_000), day = Math.floor(time / 86_400_000), period = Math.floor(day / 30);
        // A single conditional UPSERT serializes checks and updates on every supported backend.
        const rows = await db.$queryRawUnsafe<Array<{ subject: string }>>(`
            INSERT INTO hosted_usage (subject, minute, minute_requests, day, daily_requests, daily_bytes, period, period_bytes)
            SELECT CAST($1 AS TEXT), CAST($2 AS BIGINT), CAST($5 AS BIGINT), CAST($3 AS BIGINT),
                CAST($5 AS BIGINT), CAST($6 AS BIGINT), CAST($4 AS BIGINT), CAST($6 AS BIGINT)
            WHERE $5 <= $7 AND $5 <= $8 AND $6 <= $9 AND $6 <= $10
            ON CONFLICT (subject) DO UPDATE SET
                minute = $2, minute_requests = CASE WHEN hosted_usage.minute = $2 THEN hosted_usage.minute_requests ELSE 0 END + $5,
                day = $3, daily_requests = CASE WHEN hosted_usage.day = $3 THEN hosted_usage.daily_requests ELSE 0 END + $5,
                daily_bytes = CASE WHEN hosted_usage.day = $3 THEN hosted_usage.daily_bytes ELSE 0 END + $6,
                period = $4, period_bytes = CASE WHEN hosted_usage.period = $4 THEN hosted_usage.period_bytes ELSE 0 END + $6
            WHERE (CASE WHEN hosted_usage.minute = $2 THEN hosted_usage.minute_requests ELSE 0 END) + $5 <= $7
                AND (CASE WHEN hosted_usage.day = $3 THEN hosted_usage.daily_requests ELSE 0 END) + $5 <= $8
                AND (CASE WHEN hosted_usage.day = $3 THEN hosted_usage.daily_bytes ELSE 0 END) + $6 <= $9
                AND (CASE WHEN hosted_usage.period = $4 THEN hosted_usage.period_bytes ELSE 0 END) + $6 <= $10
            RETURNING subject`, subject, minute, day, period, requests, bytes,
            limits.minuteRequests, limits.dailyRequests, limits.dailyBytes, limits.periodBytes);
        if (!rows.length) throw new HostedPolicyError("Hosted analysis allowance reached. Try again later or contact the operator for a higher allowance.");
    }
}

const privateKeys = /^(?:jarPath|decompPath|sourcePath|graphPath|cacheRoot|indexPath|cachedAt|outDir|outputDir|savedTo|decompiled|indexed|embeddedCount|embedSource|embedUpdatedAt)$/i;
const sourceKeys = /^(?:source|content|text|snippet|answer|bytecode|result|raw)$/i;

export function boundHostedResult(tool: string, args: Record<string, unknown>, result: CallToolResult, limits: HostedLimits,
    allowMinecraftSource = false): CallToolResult {
    if (result.isError) return failure("Request failed. Check the arguments or ask the operator to inspect the server log.");
    if (tool === "mc_source" && !allowMinecraftSource && ["search_code", "search_indexed"].includes(String(args.action))) {
        result = { content: result.content.map(block => {
            if (block.type !== "text") throw new HostedPolicyError("This response format is unavailable remotely.");
            let rows: unknown;
            try { rows = JSON.parse(block.text); } catch { throw new HostedPolicyError("Minecraft search response unavailable."); }
            if (!Array.isArray(rows)) throw new HostedPolicyError("Minecraft search response unavailable.");
            const projected = rows.map(row => {
                if (!row || typeof row !== "object") throw new HostedPolicyError("Minecraft search response unavailable.");
                const item = row as Record<string, unknown>;
                if (args.action === "search_indexed") {
                    if (typeof item.className !== "string") throw new HostedPolicyError("Minecraft search response unavailable.");
                    return { className: item.className };
                }
                if (typeof item.file !== "string" || typeof item.line !== "number") throw new HostedPolicyError("Minecraft search response unavailable.");
                return { file: item.file.replace(/\\/g, "/"), line: item.line };
            });
            return { type: "text" as const, text: JSON.stringify(projected) };
        }) };
    }
    if (tool === "project" && !allowMinecraftSource && args.action === "search") {
        result = { content: result.content.map(block => {
            if (block.type !== "text") throw new HostedPolicyError("This response format is unavailable remotely.");
            let value: unknown;
            try { value = JSON.parse(block.text); } catch { throw new HostedPolicyError("Project search response unavailable."); }
            if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).results))
                throw new HostedPolicyError("Project search response unavailable.");
            const data = value as Record<string, unknown>;
            return { type: "text" as const, text: JSON.stringify({ ...data,
                results: (data.results as Array<Record<string, unknown>>).filter(row =>
                    typeof row?.className === "string" && !/^net[./]minecraft[./]/i.test(row.className)),
            }) };
        }) };
    }
    let truncated = false;
    let remainingLines = limits.lines;
    const clip = (text: string) => {
        const lines = text.split(/\r\n|\n|\r/);
        let value = lines.slice(0, remainingLines).join("\n");
        if (lines.length > remainingLines) truncated = true;
        remainingLines = Math.max(0, remainingLines - lines.length);
        // Byte caps also handle generated/minified one-line classes and multibyte Unicode.
        const bytes = Buffer.from(value);
        const stringBytes = Math.min(32 * 1024, Math.floor(limits.responseBytes / 2));
        if (bytes.length > stringBytes) {
            let end = stringBytes;
            while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
            value = bytes.subarray(0, end).toString("utf8");
            truncated = true;
        }
        return value;
    };
    const clean = (value: unknown, key = "", depth = 0): unknown => {
        if (depth > 20) { truncated = true; return null; }
        if (typeof value === "string") {
            if (tool === "project" && args.action === "bytecode" && key === "result") {
                value = value.split(/\r\n|\n|\r/).slice(Number(args.startLine ?? 1) - 1,
                    Number(args.startLine ?? 1) - 1 + Number(args.maxLines ?? limits.lines)).join("\n");
            }
            return sourceKeys.test(key) ? clip(value as string) : value;
        }
        if (Array.isArray(value)) return value.map(v => clean(v, key, depth + 1));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
            .filter(([k]) => !privateKeys.test(k)).map(([k, v]) => [k, clean(v, k, depth + 1)]));
        return value;
    };
    const content: CallToolResult["content"] = [];
    for (const block of result.content) {
        // No file/resource links, binary payloads, hidden structuredContent or metadata bypasses.
        if (block.type !== "text") throw new HostedPolicyError("This response format is unavailable remotely.");
        let value: unknown;
        // Source text must not evade line limits by happening to parse as JSON.
        try { value = rawSource(tool, args.action) && tool !== "project" ? undefined : JSON.parse(block.text); } catch { value = undefined; }
        let text: string;
        // Bytecode/mod source implementations that lack pagination are sliced before clipping.
        if (rawSource(tool, args.action) && value === undefined && !(tool === "mc_source" && args.action === "get_source") && !(tool === "mod" && args.action === "source")) {
            text = clip(block.text.split(/\r\n|\n|\r/).slice(Number(args.startLine ?? 1) - 1,
                Number(args.startLine ?? 1) - 1 + Number(args.maxLines ?? limits.lines)).join("\n"));
        } else text = value === undefined ? clip(block.text) : JSON.stringify(clean(value));
        content.push({ type: "text", text });
    }
    if (truncated) content.push({ type: "text", text: "Response limited. Narrow the query or request a specific source range." });
    if (Buffer.byteLength(JSON.stringify(content)) > limits.responseBytes) {
        throw new HostedPolicyError("Response too large. Narrow the query or request a smaller source range.");
    }
    return { content };
}

function failure(text: string): CallToolResult {
    return { isError: true, content: [{ type: "text", text }] };
}

export async function runHostedTool(tool: string, input: Record<string, unknown>, subject: string,
    limits: HostedLimits, budget: HostedBudget, run: (args: Record<string, unknown>) => Promise<CallToolResult>,
    allowMinecraftSource = false): Promise<CallToolResult> {
    try {
        await budget.charge(subject, limits, 1, 0);
        const args = prepareHostedArgs(tool, input, limits, allowMinecraftSource);
        const review = await guardHostedMod(tool, args);
        const result = review.blocked
            ? boundHostedResult("mod_license", { action: "check" }, review.blocked, limits)
            : attachLicenseNotices(boundHostedResult(tool, args, await run(args), limits, allowMinecraftSource), review.notices ?? []);
        // License notices must remain complete even when all 200 source lines are
        // used. Reject the whole response if source plus notices exceeds the cap.
        if (Buffer.byteLength(JSON.stringify(result.content)) > limits.responseBytes) {
            throw new HostedPolicyError("Source and required license notices exceed the response limit. Request a smaller source range or use the local workflow.");
        }
        // Charge before release, atomically, including search snippets, bytecode and alternate routes.
        await budget.charge(subject, limits, 0, Buffer.byteLength(JSON.stringify(result.content)));
        return result;
    } catch (error) {
        if (!(error instanceof HostedPolicyError)) console.error("[modlens] hosted policy failure", error);
        return failure(error instanceof HostedPolicyError ? error.message : "Hosted request unavailable. Contact the operator.");
    }
}
