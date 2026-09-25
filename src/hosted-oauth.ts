import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "./db.js";

type Database = Awaited<ReturnType<typeof getDb>>;
type RecordRow = { id: string; kind: string; payload: string; expires: bigint | number };
type GrantRow = {
    id: string; client_id: string; subject: string; resource: string; upstream_access: string;
    upstream_refresh: string | null; upstream_expires: bigint | number; refresh_hash: string | null;
    refresh_expires: bigint | number;
};
type UpstreamTokens = { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string };
type AuthConfig = {
    resource: URL; issuer: string; clientId: string; clientSecret?: string; scopes: string;
    profileUrl: string; subjectField: string; requiredField?: string; requiredValue?: string;
    key: Buffer; authorizeUrl: string; tokenUrl: string; requiresIss: boolean; log: boolean;
    codexRefreshWorkaround: boolean;
};

export class HostedOAuthError extends Error {
    constructor(message: string, public status = 400, public code = "invalid_request", public flowId?: string) { super(message); }
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (prefix: string) => prefix + randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
// Temporary Codex MCP OAuth workaround: see https://github.com/openai/codex/issues/17265.
// Remove the long-lived branch in issue() once Codex reliably shares rotated refresh credentials.
const CODEX_WORKAROUND_ACCESS_TOKEN_TTL = 30 * 24 * 60 * 60;
const oauthLog = (enabled: boolean, event: string, fields: Record<string, string | number | boolean | undefined>) => {
    if (enabled) console.error(`[modlens] oauth ${JSON.stringify({ event, ...fields })}`);
};
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...headers });
    res.end(JSON.stringify(value));
};
const redirect = (res: ServerResponse, url: URL) => {
    res.writeHead(302, { Location: url.toString(), "Cache-Control": "no-store" });
    res.end();
};
const htmlCsp = (formAction = "'self'") =>
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`;
const htmlHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": htmlCsp(),
};
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function page(title: string, content: string, tone: "consent" | "error" = "consent"): string {
    const status = tone === "error" ? "CONNECTION INTERRUPTED" : "APP CONNECTION";
    const year = new Date().getUTCFullYear();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)} · ModLens</title>
<style>
:root{--page:#171c21;--panel-top:#1e2328;--panel-bottom:#171c21;--panel-deep:#13181d;--line:#2b3138;--line-dark:#13171c;--text:#f0f0f5;--muted:#8b97a5;--green:#06c200;--green-dark:#035c00;--focus:#65dcd5;--error:#ffa7cc}
*{box-sizing:border-box}
html,body{margin:0;min-width:320px;min-height:100%;background:var(--page);color:var(--text);font-family:Inter,"Segoe UI Variable","Segoe UI",sans-serif;font-size:16px;line-height:1.5}
body{min-height:100vh;background:linear-gradient(-45deg,transparent,#ffffff03,#ffffff0d,#ffffff1a);display:flex;flex-direction:column}
.page{width:100%;min-height:100vh;display:flex;flex-direction:column;justify-content:space-between}
main{width:100%;display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:38px 17px 24px}
.brand{display:flex;align-items:center;justify-content:center;margin:0 auto 22px;color:white}.brand-copy{text-align:center;line-height:1}.brand-copy strong{display:block;font-size:21px;font-weight:750;letter-spacing:.13em}.brand-copy small{display:block;margin-top:7px;color:#ffffff73;font-size:10px;font-weight:650;letter-spacing:.31em}
.card{width:min(638px,calc(100vw - 34px));border:1px solid var(--line);outline:1px solid var(--line-dark);border-radius:10px;overflow:hidden;background:linear-gradient(180deg,var(--panel-top),var(--panel-bottom));box-shadow:0 0 25px rgba(0,0,0,.2)}
.content{padding:32px;text-align:left}.eyebrow{display:block;margin:0 0 7px;color:${tone === "error" ? "var(--error)" : "#72d96e"};font-size:10px;font-weight:700;letter-spacing:.17em}.content h1{margin:0;color:var(--text);font-family:"Centra No 2","Segoe UI Variable","Segoe UI",sans-serif;font-size:30px;line-height:36px;letter-spacing:-.03em;font-weight:500}.lead,.content>p{margin:9px 0 0;color:#ffffffb3;font-size:14px;line-height:1.6}
.app{display:flex;align-items:center;gap:12px;margin:20px 0 12px;padding:12px;background:var(--panel-deep);border:1px solid var(--line);border-radius:6px}.app-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;flex:0 0 auto;border-radius:50%;background:#06c20020;color:#8cdd88;font:600 12px/1 Consolas,monospace}.app-copy{min-width:0}.app-name{display:block;color:#f0f0f5;font-size:14px}.app-label{display:block;color:var(--muted);font-size:11px}
.connection-details{color:var(--muted);font-size:12px}.connection-details summary{width:max-content;max-width:100%;cursor:pointer;color:#d7dbe0}.connection-details summary:focus-visible{outline:2px solid var(--focus);outline-offset:3px}.connection-details p{margin:10px 0 6px}.callback-url{display:block;overflow-wrap:anywhere;color:#d7dbe0;font:500 12px/1.5 Consolas,monospace}
.permissions{margin:20px 0;padding-left:22px;color:#d7dbe0;font-size:13px;line-height:1.65}.permissions li+li{margin-top:9px}.permissions li::marker{color:#48c544}
form{margin:0}.actions{display:grid;grid-template-columns:1fr 1.6fr;gap:12px;margin-top:24px}button{display:inline-flex;min-height:48px;align-items:center;justify-content:center;appearance:none;border:1px solid transparent;border-radius:4px;padding:10px 16px;color:white;font:500 14px/1 "Segoe UI Variable","Segoe UI",sans-serif;cursor:pointer;transition:box-shadow .18s ease,background .18s ease}button:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:3px}.primary{background:linear-gradient(to left,var(--green),var(--green-dark))}.primary:hover{box-shadow:0 0 20px #42d80854}.secondary{background:#242b33;border-color:#343b44}.secondary:hover{background:#2d353e}
.note{margin:12px 0 0!important;color:#ffffff73!important;font-size:11px!important}.error-code{display:block;margin-top:20px;padding:12px;border:1px solid #d1005650;border-radius:4px;background:#d1005615;color:var(--error);font:12px/1.55 Consolas,monospace;overflow-wrap:anywhere}
footer{width:100%;margin-top:32px;padding:20px 40px;border-top:1px solid #262626;background:#0000000f;color:#ffffff73;font-size:10px}.footer-row{display:flex;align-items:center;gap:24px;max-width:1180px;margin:auto}.footer-brand{color:#fff;font-weight:750;letter-spacing:.14em}.copyright{max-width:630px;text-transform:uppercase}.footer-spacer{flex:1}.footer-links{display:flex;gap:14px}.footer-links a{color:var(--green);text-decoration:none;text-transform:uppercase}.footer-links a:hover{text-decoration:underline}
@media(max-width:620px){main{padding-top:28px}.content{padding:24px}.actions{grid-template-columns:1fr}.primary{grid-row:1}.secondary{grid-row:2}.app{align-items:flex-start}.footer-row{flex-direction:column;text-align:center;gap:10px}footer{padding:20px}.copyright{max-width:100%}.footer-links{flex-wrap:wrap;justify-content:center}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style>
</head>
<body>
<div class="page"><main><div class="brand"><span class="brand-copy"><strong>CREEPERHOST</strong><small>MODLENS</small></span></div><section class="card"><div class="content"><span class="eyebrow">${status}</span>${content}</div></section></main>
<footer><div class="footer-row"><span class="footer-brand">CREEPERHOST</span><span class="copyright">© 2011 - ${year} CreeperHost® LTD. All rights reserved. Registered in England and Wales · Company #08401051 · VAT #GB 160 6059 26</span><span class="footer-spacer"></span><nav class="footer-links" aria-label="Legal"><a href="https://www.creeperhost.net/tos" target="_blank" rel="noopener">Terms</a><a href="https://www.creeperhost.net/privacy" target="_blank" rel="noopener">Privacy</a><a href="https://www.creeperhost.net/policies" target="_blank" rel="noopener">Policies</a></nav></div></footer></div>
</body>
</html>`;
}
const field = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((current, part) =>
    current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>)[part] : undefined, value);

function secureUrl(raw: string, label: string, loopback = false): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`${label} must be an absolute URL`); }
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"
        && ["127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash || url.search)
        throw new Error(`${label} must be HTTPS (or loopback HTTP), without credentials, query or fragment`);
    return url;
}

function callbackSafe(raw: string): boolean {
    try {
        const url = new URL(raw);
        return raw.length <= 2048 && !url.username && !url.password && !url.hash &&
            (url.protocol === "https:" || (url.protocol === "http:" &&
                ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) && url.toString() === raw;
    } catch { return false; }
}

async function body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024) throw new HostedOAuthError("Request too large", 413);
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

function form(raw: string): URLSearchParams {
    const params = new URLSearchParams(raw);
    const seen = new Set<string>();
    for (const [key] of params) {
        if (seen.has(key)) throw new HostedOAuthError("Duplicate form parameter");
        seen.add(key);
    }
    return params;
}

function uniqueQuery(params: URLSearchParams): void {
    const seen = new Set<string>();
    for (const [key] of params) {
        if (seen.has(key)) throw new HostedOAuthError("Duplicate query parameter");
        seen.add(key);
    }
}

function required(params: URLSearchParams, key: string): string {
    const value = params.get(key);
    if (!value) throw new HostedOAuthError(`Missing ${key}`);
    return value;
}

function challenge(verifier: string): string {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new HostedOAuthError("Invalid PKCE verifier", 400, "invalid_grant");
    return createHash("sha256").update(verifier).digest("base64url");
}

async function safeResponseExcerpt(response: Response): Promise<string> {
    let value: string;
    try { value = await response.clone().text(); }
    catch { return "[unreadable response body]"; }
    return value.slice(0, 2048)
        .replace(/Bearer\s+[^\s"'<]+/gi, "Bearer [redacted]")
        .replace(/(access_token|refresh_token|id_token|client_secret|authorization|assertion|password|code|state)(["']?\s*[:=]\s*["']?)[^"',\s<}&]+/gi,
            "$1$2[redacted]");
}

async function providerMetadata(url: URL, log: boolean): Promise<Response> {
    const attempts = 4;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10000) });
        } catch (error) {
            if (attempt === attempts) throw new Error(`OAuth provider metadata request failed for ${url}`, { cause: error });
            oauthLog(log, "provider_metadata_retry", { endpoint: url.toString(), attempt,
                reason: error instanceof Error ? error.name : "request_error" });
            await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
            continue;
        }
        oauthLog(log, "provider_metadata_response", { endpoint: url.toString(),
            attempt, status: response.status, contentType: response.headers.get("content-type") ?? "",
            ...(response.ok || !log ? {} : { response: await safeResponseExcerpt(response) }) });
        if (response.ok || response.status === 404 || (response.status !== 429 && response.status < 500)) return response;
        if (attempt === attempts) return response;
        oauthLog(log, "provider_metadata_retry", { endpoint: url.toString(), attempt, status: response.status });
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
    throw new Error("OAuth provider metadata retry loop ended unexpectedly");
}

export class HostedOAuth {
    private ready?: Promise<void>;
    private readonly instance = randomBytes(6).toString("hex");
    private requestCounts = new Map<string, { minute: number; count: number }>();
    private refreshes = new Map<string, Promise<Record<string, unknown>>>();
    private upstreamRefreshes = new Map<string, Promise<GrantRow>>();
    private constructor(private config: AuthConfig, private database: () => Promise<Database>) {}

    private audit(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
        oauthLog(this.config.log, event, { instance: this.instance, ...fields });
    }

    private clientRef(clientId: string): string { return sha(clientId).slice(0, 12); }
    private grantRef(grantId: string): string { return sha(grantId).slice(0, 12); }

    private observeTokenResponse(req: IncomingMessage, res: ServerResponse,
        fields: Record<string, string | number | boolean | undefined>): void {
        if (!this.config.log) return;
        const startedAt = performance.now();
        let finished = false;
        req.once("aborted", () => this.audit("token_request_aborted", fields));
        res.once("finish", () => {
            finished = true;
            this.audit("token_response_finished", { ...fields, status: res.statusCode,
                outcome: res.statusCode >= 400 ? "error" : fields.outcome,
                durationMs: Math.round(performance.now() - startedAt) });
        });
        res.once("close", () => {
            if (!finished) this.audit("token_response_closed", { ...fields, status: res.statusCode,
                headersSent: res.headersSent, writableEnded: res.writableEnded, writableFinished: res.writableFinished,
                durationMs: Math.round(performance.now() - startedAt) });
        });
        res.once("error", error => this.audit("token_response_error", { ...fields, status: res.statusCode,
            error: error.name, errorCode: (error as NodeJS.ErrnoException).code }));
    }

    private describeTokenResponse(response: Record<string, unknown>): Record<string, string | number | boolean> {
        const access = typeof response.access_token === "string" ? response.access_token : undefined;
        const refresh = typeof response.refresh_token === "string" ? response.refresh_token : undefined;
        return {
            outcome: "success", responseBytes: Buffer.byteLength(JSON.stringify(response)),
            returnedRefresh: refresh !== undefined,
            ...(access ? { accessRef: sha(access).slice(0, 12) } : {}),
            ...(refresh ? { returnedRefreshRef: sha(refresh).slice(0, 12) } : {}),
            ...(typeof response.expires_in === "number" ? { accessExpiresIn: response.expires_in } : {}),
        };
    }

    logError(method: string | undefined, route: string, error: HostedOAuthError): string {
        const incident = randomBytes(6).toString("hex");
        this.audit("request_failed", { incident, flow: error.flowId, method: method ?? "UNKNOWN", route,
            status: error.status, code: error.code, description: error.message });
        return incident;
    }

    static async create(env: NodeJS.ProcessEnv = process.env, database: () => Promise<Database> = getDb): Promise<HostedOAuth> {
        const log = env.MODLENS_OAUTH_LOG === "1";
        const workaroundSetting = env.MODLENS_OAUTH_CODEX_REFRESH_WORKAROUND ?? "1";
        if (workaroundSetting !== "0" && workaroundSetting !== "1")
            throw new Error("MODLENS_OAUTH_CODEX_REFRESH_WORKAROUND must be 0 or 1");
        const resource = secureUrl(env.MODLENS_OAUTH_PUBLIC_URL ?? "", "MODLENS_OAUTH_PUBLIC_URL", true);
        const issuer = secureUrl(env.MODLENS_OAUTH_ISSUER ?? "", "MODLENS_OAUTH_ISSUER", true).toString().replace(/\/$/, "");
        const clientId = env.MODLENS_OAUTH_CLIENT_ID;
        if (!clientId) throw new Error("MODLENS_OAUTH_CLIENT_ID is required");
        const scopes = env.MODLENS_OAUTH_SCOPES?.trim();
        if (!scopes || scopes.length > 2048 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(scopes))
            throw new Error("MODLENS_OAUTH_SCOPES must be a space-separated scope list");
        const key = Buffer.from(env.MODLENS_OAUTH_STORAGE_KEY ?? "", "base64");
        if (key.length !== 32) throw new Error("MODLENS_OAUTH_STORAGE_KEY must be a base64-encoded 32-byte key");
        const subjectField = env.MODLENS_OAUTH_SUBJECT_FIELD ?? "sub";
        const requiredField = env.MODLENS_OAUTH_REQUIRED_FIELD;
        if (![subjectField, requiredField].filter(Boolean).every(value => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value!)))
            throw new Error("OAuth profile field names must be dotted JSON paths");
        if (!!requiredField !== (env.MODLENS_OAUTH_REQUIRED_VALUE !== undefined))
            throw new Error("MODLENS_OAUTH_REQUIRED_FIELD and MODLENS_OAUTH_REQUIRED_VALUE must be configured together");
        const path = new URL(issuer).pathname.replace(/\/$/, "");
        let metadataUrl = new URL(`/.well-known/oauth-authorization-server${path === "/" ? "" : path}`, issuer);
        let response = await providerMetadata(metadataUrl, log);
        if (response.status === 404) {
            metadataUrl = new URL(".well-known/openid-configuration", issuer + "/");
            response = await providerMetadata(metadataUrl, log);
        }
        if (!response.ok) throw new Error(`OAuth provider metadata unavailable: HTTP ${response.status} from ${metadataUrl}`);
        const metadata = await response.json() as Record<string, unknown>;
        if (metadata.issuer !== issuer) throw new Error("OAuth provider issuer mismatch");
        const authorizeUrl = secureUrl(String(metadata.authorization_endpoint ?? ""), "authorization endpoint", true).toString();
        const tokenUrl = secureUrl(String(metadata.token_endpoint ?? ""), "token endpoint", true).toString();
        const profileUrl = secureUrl(String(env.MODLENS_OAUTH_PROFILE_URL ?? metadata.userinfo_endpoint ?? ""),
            "MODLENS_OAUTH_PROFILE_URL", true).toString();
        const instance = new HostedOAuth({ resource, issuer, clientId, clientSecret: env.MODLENS_OAUTH_CLIENT_SECRET,
            scopes, profileUrl, subjectField, requiredField, requiredValue: env.MODLENS_OAUTH_REQUIRED_VALUE,
            key, authorizeUrl, tokenUrl, requiresIss: metadata.authorization_response_iss_parameter_supported === true,
            log, codexRefreshWorkaround: workaroundSetting === "1" }, database);
        await instance.db();
        return instance;
    }

    private async db(): Promise<Database> {
        const db = await this.database();
        if (!this.ready) this.ready = (async () => {
            await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hosted_oauth_clients (
                id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, created BIGINT NOT NULL)`);
            await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hosted_oauth_client_metadata (
                id TEXT PRIMARY KEY, client_name TEXT NOT NULL)`);
            await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hosted_oauth_objects (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, expires BIGINT NOT NULL)`);
            await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hosted_oauth_grants (
                id TEXT PRIMARY KEY, client_id TEXT NOT NULL, subject TEXT NOT NULL, resource TEXT NOT NULL,
                upstream_access TEXT NOT NULL, upstream_refresh TEXT, upstream_expires BIGINT NOT NULL,
                refresh_hash TEXT, refresh_expires BIGINT NOT NULL)`);
            await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hosted_oauth_access (
                token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, expires BIGINT NOT NULL)`);
        })().catch(error => { this.ready = undefined; throw error; });
        await this.ready;
        return db;
    }

    private seal(value: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.config.key, iv);
        const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
    }

    private open(value: string): string {
        const bytes = Buffer.from(value, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", this.config.key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    }

    private async putObject(kind: string, payload: unknown, ttl: number): Promise<string> {
        const id = token("mlo_");
        const db = await this.db();
        await db.$executeRawUnsafe(`DELETE FROM hosted_oauth_objects WHERE expires<$1`, now());
        await db.$executeRawUnsafe(`INSERT INTO hosted_oauth_objects (id,kind,payload,expires) VALUES ($1,$2,$3,$4)`,
            sha(id), kind, this.seal(JSON.stringify(payload)), now() + ttl);
        return id;
    }

    private async putObjectAt(id: string, kind: string, payload: unknown, ttl: number): Promise<void> {
        const db = await this.db();
        await db.$executeRawUnsafe(`INSERT INTO hosted_oauth_objects (id,kind,payload,expires) VALUES ($1,$2,$3,$4)
            ON CONFLICT (id) DO UPDATE SET kind=$2,payload=$3,expires=$4`,
        sha(id), kind, this.seal(JSON.stringify(payload)), now() + ttl);
    }

    private async getObject(id: string, kind: string): Promise<unknown | undefined> {
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<RecordRow[]>(`SELECT id,kind,payload,expires FROM hosted_oauth_objects
            WHERE id=$1 AND kind=$2 AND expires>$3`, sha(id), kind, now());
        return rows.length === 1 ? JSON.parse(this.open(rows[0].payload)) : undefined;
    }

    private async takeObject(id: string, kind: string): Promise<unknown> {
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<RecordRow[]>(`DELETE FROM hosted_oauth_objects
            WHERE id=$1 AND kind=$2 AND expires>$3 RETURNING id,kind,payload,expires`, sha(id), kind, now());
        if (rows.length !== 1) {
            const label = kind === "state" ? "provider callback" : kind === "approval" ? "consent request" : "authorization code";
            throw new HostedOAuthError(`Expired or reused ${label}`, 400, "invalid_grant");
        }
        return JSON.parse(this.open(rows[0].payload));
    }

    private async client(clientId: string): Promise<string[]> {
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<Array<{ redirect_uris: string }>>(
            `SELECT redirect_uris FROM hosted_oauth_clients WHERE id=$1`, clientId);
        if (rows.length !== 1) throw new HostedOAuthError("Unknown OAuth client", 400, "invalid_client");
        return JSON.parse(rows[0].redirect_uris);
    }

    private async clientName(clientId: string): Promise<string | undefined> {
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<Array<{ client_name: string }>>(
            `SELECT client_name FROM hosted_oauth_client_metadata WHERE id=$1`, clientId);
        return rows[0]?.client_name;
    }

    private async upstreamToken(values: URLSearchParams): Promise<UpstreamTokens> {
        const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
        values.set("client_id", this.config.clientId);
        if (this.config.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
        let response: Response;
        try { response = await fetch(this.config.tokenUrl, { method: "POST", headers, body: values,
            redirect: "error", signal: AbortSignal.timeout(10000) }); }
        catch { throw new HostedOAuthError("Provider token endpoint unavailable", 503, "temporarily_unavailable"); }
        if (!response.ok) {
            this.audit("provider_token_response", { endpoint: this.config.tokenUrl, grantType: values.get("grant_type") ?? "unknown",
                status: response.status, contentType: response.headers.get("content-type") ?? "",
                response: await safeResponseExcerpt(response) });
            throw new HostedOAuthError("Provider token exchange failed", response.status >= 500 ? 503 : 401, "invalid_grant");
        }
        let data: UpstreamTokens;
        try { data = await response.json() as UpstreamTokens; }
        catch { throw new HostedOAuthError("Invalid provider token response", 503, "temporarily_unavailable"); }
        if (!data || typeof data.access_token !== "string" || !data.access_token ||
            (data.token_type && data.token_type.toLowerCase() !== "bearer")) throw new HostedOAuthError("Invalid provider token response", 503);
        return data;
    }

    private async profile(access: string): Promise<{ subject: string; allowed: boolean }> {
        let response: Response;
        try { response = await fetch(this.config.profileUrl, { headers: { Authorization: `Bearer ${access}` },
            redirect: "error", signal: AbortSignal.timeout(10000) }); }
        catch { throw new HostedOAuthError("Provider profile unavailable", 503, "temporarily_unavailable"); }
        if (!response.ok) {
            this.audit("provider_profile_response", { endpoint: this.config.profileUrl, status: response.status,
                contentType: response.headers.get("content-type") ?? "", bodyLogged: false });
            throw new HostedOAuthError("Provider profile unavailable", response.status === 401 || response.status === 403 ? 401 : 503,
                response.status === 401 || response.status === 403 ? "invalid_token" : "temporarily_unavailable");
        }
        let data: unknown;
        try { data = await response.json() as unknown; }
        catch { throw new HostedOAuthError("Invalid provider profile", 503, "temporarily_unavailable"); }
        const rawSubject = field(data, this.config.subjectField);
        const subject = typeof rawSubject === "string" ? rawSubject
            : typeof rawSubject === "number" && Number.isSafeInteger(rawSubject) ? String(rawSubject) : "";
        if (!subject || subject.length > 256)
            throw new HostedOAuthError("Provider profile has no stable subject", 403, "access_denied");
        let allowed = true;
        if (this.config.requiredField) {
            const actual = field(data, this.config.requiredField);
            const configured = this.config.requiredValue!;
            let expected: unknown = configured;
            try {
                const parsed = JSON.parse(configured) as unknown;
                if (parsed === null || ["string", "number", "boolean"].includes(typeof parsed)) expected = parsed;
            } catch { /* Unquoted string values are valid configuration. */ }
            allowed = actual === expected;
        }
        return { subject, allowed };
    }

    private callbackUrl(): string { return new URL("/oauth/upstream/callback", this.config.resource).toString(); }
    private issuerUrl(): string { return this.config.resource.origin; }
    private metadataUrl(): string {
        return new URL(`/.well-known/oauth-protected-resource${this.config.resource.pathname}`, this.config.resource).toString();
    }

    challenge(res: ServerResponse): void {
        json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": `Bearer resource_metadata="${this.metadataUrl()}", scope="modlens"` });
    }

    browserError(res: ServerResponse, error: HostedOAuthError, incident?: string): void {
        const expired = error.code === "invalid_grant" && error.message.startsWith("Expired or reused");
        const title = expired ? "This connection request has expired" : "ModLens could not finish connecting";
        const detail = expired
            ? "Return to Codex and start the connection again. Authorization requests are short-lived and can only be used once."
            : "Return to Codex and try connecting again. If the problem continues, check the ModLens server logs for the matching OAuth request.";
        const reference = incident ? ` · ref ${incident}` : "";
        const content = `<h1>${escapeHtml(title)}</h1><p class="lead">${escapeHtml(detail)}</p>`
            + `<span class="error-code">${escapeHtml(error.code)} · ${escapeHtml(error.message + reference)}</span>`;
        res.writeHead(error.status, htmlHeaders);
        res.end(page(title, content, "error"));
    }

    async authenticate(req: IncomingMessage): Promise<string> {
        for (const name of Object.keys(req.headers)) if (name.startsWith("x-modlens-"))
            throw new HostedOAuthError("Gateway headers are not accepted in OAuth mode", 401, "invalid_token");
        const value = req.headers.authorization;
        if (typeof value !== "string" || !/^Bearer m[a-z]+_[A-Za-z0-9_-]{43}$/.test(value))
            throw new HostedOAuthError("Bearer token required", 401, "invalid_token");
        const raw = value.slice(7);
        if (!this.config.codexRefreshWorkaround && raw.startsWith("mlw_"))
            throw new HostedOAuthError("Long-lived access token disabled", 401, "invalid_token");
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<Array<GrantRow & { access_expires: bigint | number }>>(
            `SELECT g.*, a.expires AS access_expires FROM hosted_oauth_access a
             JOIN hosted_oauth_grants g ON g.id=a.grant_id WHERE a.token_hash=$1 AND a.expires>$2`, sha(raw), now());
        if (rows.length !== 1 || rows[0].resource !== this.config.resource.toString())
            throw new HostedOAuthError("Invalid access token", 401, "invalid_token");
        const grant = rows[0];
        try {
            const { profile } = await this.profileForGrant(grant);
            if (!profile.allowed || profile.subject !== grant.subject) {
                await this.revoke(grant.id, "profile_access_denied");
                throw new HostedOAuthError("Account access denied", 403, "access_denied");
            }
        } catch (error) {
            if (error instanceof HostedOAuthError && error.status === 401)
                await this.revoke(grant.id, "profile_unauthorized");
            throw error;
        }
        return sha(this.config.issuer + "\0" + grant.subject);
    }

    private async revoke(id: string, reason: string): Promise<void> {
        const db = await this.db();
        await db.$executeRawUnsafe(`DELETE FROM hosted_oauth_access WHERE grant_id=$1`, id);
        await db.$executeRawUnsafe(`DELETE FROM hosted_oauth_grants WHERE id=$1`, id);
        this.audit("grant_revoked", { grant: this.grantRef(id), reason });
    }

    private async issue(grant: GrantRow): Promise<Record<string, unknown>> {
        const rawAccess = token(this.config.codexRefreshWorkaround ? "mlw_" : "mla_");
        const expires = this.config.codexRefreshWorkaround ? CODEX_WORKAROUND_ACCESS_TOKEN_TTL
            : Math.max(1, Math.min(300, Number(grant.upstream_expires) - now() - 5));
        const db = await this.db();
        await db.$executeRawUnsafe(`INSERT INTO hosted_oauth_access (token_hash,grant_id,expires) VALUES ($1,$2,$3)`,
            sha(rawAccess), grant.id, now() + expires);
        return { access_token: rawAccess, token_type: "Bearer", expires_in: expires, scope: "modlens" };
    }

    private async currentUpstream(grant: GrantRow, force = false): Promise<GrantRow> {
        if (!force && Number(grant.upstream_expires) > now() + 5) return grant;
        let pending = this.upstreamRefreshes.get(grant.id);
        if (!pending) {
            pending = (async () => {
                const db = await this.db();
                const rows = await db.$queryRawUnsafe<GrantRow[]>(`SELECT * FROM hosted_oauth_grants WHERE id=$1`, grant.id);
                const current = rows[0];
                if (!current) throw new HostedOAuthError("Provider authorization expired", 401, "invalid_token");
                if ((force && current.upstream_access !== grant.upstream_access) ||
                    (!force && Number(current.upstream_expires) > now() + 5)) return current;
                if (!current.upstream_refresh)
                    throw new HostedOAuthError("Provider authorization expired", 401, "invalid_token");
                const upstream = await this.upstreamToken(new URLSearchParams({ grant_type: "refresh_token",
                    refresh_token: this.open(current.upstream_refresh) }));
                current.upstream_access = this.seal(upstream.access_token);
                current.upstream_refresh = this.seal(upstream.refresh_token ?? this.open(current.upstream_refresh));
                current.upstream_expires = now() + Math.max(1, Math.min(86400, Number(upstream.expires_in) || 300));
                await db.$executeRawUnsafe(`UPDATE hosted_oauth_grants SET upstream_access=$2,upstream_refresh=$3,
                    upstream_expires=$4 WHERE id=$1`, current.id, current.upstream_access,
                    current.upstream_refresh, current.upstream_expires);
                return current;
            })();
            this.upstreamRefreshes.set(grant.id, pending);
            void pending.finally(() => this.upstreamRefreshes.delete(grant.id)).catch(() => {});
        }
        return pending;
    }

    private async profileForGrant(grant: GrantRow): Promise<{
        current: GrantRow; profile: { subject: string; allowed: boolean };
    }> {
        const current = await this.currentUpstream(grant);
        try { return { current, profile: await this.profile(this.open(current.upstream_access)) }; }
        catch (error) {
            if (!(error instanceof HostedOAuthError) || error.status !== 401) throw error;
            const refreshed = await this.currentUpstream(current, true);
            return { current: refreshed, profile: await this.profile(this.open(refreshed.upstream_access)) };
        }
    }

    private async refresh(clientId: string, raw: string, requestRef: string): Promise<Record<string, unknown>> {
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<GrantRow[]>(`UPDATE hosted_oauth_grants SET refresh_hash=NULL
            WHERE refresh_hash=$1 AND client_id=$2 AND refresh_expires>$3 RETURNING *`, sha(raw), clientId, now());
        if (rows.length !== 1 || !rows[0].upstream_refresh) {
            this.audit("refresh_rejected", { request: requestRef, client: this.clientRef(clientId), refreshRef: sha(raw).slice(0, 12),
                reason: rows.length === 1 ? "no_upstream_refresh" : "not_current_or_missing" });
            throw new HostedOAuthError("Invalid refresh token", 400, "invalid_grant");
        }
        const grant = rows[0];
        let stage = "provider_token";
        try {
            stage = "profile";
            const { current, profile } = await this.profileForGrant(grant);
            if (profile.subject !== grant.subject || !profile.allowed) throw new HostedOAuthError("Account access denied", 403, "access_denied");
            const next = token("mlr_");
            grant.refresh_hash = sha(next);
            stage = "rotation";
            await db.$executeRawUnsafe(`UPDATE hosted_oauth_grants SET refresh_hash=$2 WHERE id=$1`, grant.id, grant.refresh_hash);
            stage = "access_issue";
            const access = await this.issue(current);
            const response = { ...access, refresh_token: next };
            this.audit("refresh_issued", { request: requestRef, client: this.clientRef(clientId), grant: this.grantRef(grant.id),
                previousRefreshRef: sha(raw).slice(0, 12), refreshRef: sha(next).slice(0, 12),
                accessExpiresIn: Number(access.expires_in) });
            return response;
        } catch (error) {
            const retryable = error instanceof HostedOAuthError && error.status === 503;
            this.audit("refresh_failed", { request: requestRef, client: this.clientRef(clientId), grant: this.grantRef(grant.id),
                refreshRef: sha(raw).slice(0, 12), stage, retryable,
                status: error instanceof HostedOAuthError ? error.status : undefined,
                code: error instanceof HostedOAuthError ? error.code : undefined });
            if (retryable) {
                await db.$executeRawUnsafe(`UPDATE hosted_oauth_grants SET refresh_hash=$2 WHERE id=$1 AND refresh_hash IS NULL`, grant.id, sha(raw));
            } else await this.revoke(grant.id, "refresh_failed");
            throw error;
        }
    }

    private limit(req: IncomingMessage, route: string, maximum: number): void {
        const minute = Math.floor(now() / 60);
        const key = `${route}:${req.socket.remoteAddress ?? "unknown"}`;
        const entry = this.requestCounts.get(key);
        const count = entry?.minute === minute ? entry.count + 1 : 1;
        this.requestCounts.set(key, { minute, count });
        if (this.requestCounts.size > 10000) {
            for (const [id, value] of this.requestCounts) if (value.minute !== minute) this.requestCounts.delete(id);
        }
        if (count > maximum) throw new HostedOAuthError("Too many authorization requests", 429, "slow_down");
    }

    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
        const route = url.pathname;
        if (route === this.metadataUrlPath() || route === "/.well-known/oauth-protected-resource") {
            if (req.method !== "GET") throw new HostedOAuthError("Method not allowed", 405);
            json(res, 200, { resource: this.config.resource.toString(), authorization_servers: [this.issuerUrl()],
                scopes_supported: ["modlens"], bearer_methods_supported: ["header"] });
            return true;
        }
        if (route === "/.well-known/oauth-authorization-server") {
            if (req.method !== "GET") throw new HostedOAuthError("Method not allowed", 405);
            json(res, 200, { issuer: this.issuerUrl(), authorization_endpoint: this.issuerUrl() + "/oauth/authorize",
                token_endpoint: this.issuerUrl() + "/oauth/token", registration_endpoint: this.issuerUrl() + "/oauth/register",
                revocation_endpoint: this.issuerUrl() + "/oauth/revoke", response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["modlens"],
                authorization_response_iss_parameter_supported: true });
            return true;
        }
        if (route === "/oauth/register" && req.method === "POST") {
            this.limit(req, route, 120);
            let registration: Record<string, unknown>;
            try { registration = JSON.parse(await body(req)); } catch { throw new HostedOAuthError("Invalid client registration"); }
            const redirects = registration.redirect_uris;
            if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 ||
                !redirects.every(value => typeof value === "string" && callbackSafe(value)) ||
                (registration.token_endpoint_auth_method && registration.token_endpoint_auth_method !== "none"))
                throw new HostedOAuthError("Invalid client registration");
            const clientName = registration.client_name;
            if (clientName !== undefined && (typeof clientName !== "string" || !clientName.trim() ||
                clientName.length > 120 || /[\x00-\x1f\x7f]/.test(clientName)))
                throw new HostedOAuthError("Invalid client name");
            const id = token("mlc_");
            const db = await this.db();
            await db.$executeRawUnsafe(`INSERT INTO hosted_oauth_clients (id,redirect_uris,created) VALUES ($1,$2,$3)`,
                id, JSON.stringify(redirects), now());
            if (clientName !== undefined) await db.$executeRawUnsafe(
                `INSERT INTO hosted_oauth_client_metadata (id,client_name) VALUES ($1,$2)`, id, clientName);
            this.audit("client_registered", { client: this.clientRef(id), redirects: redirects.length });
            json(res, 201, { client_id: id, redirect_uris: redirects, grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"], token_endpoint_auth_method: "none",
                ...(clientName === undefined ? {} : { client_name: clientName }) });
            return true;
        }
        if (route === "/oauth/authorize" && req.method === "GET") {
            this.limit(req, route, 600);
            const params = url.searchParams;
            uniqueQuery(params);
            const clientId = required(params, "client_id");
            const redirects = await this.client(clientId);
            const callback = required(params, "redirect_uri");
            if (!redirects.includes(callback)) throw new HostedOAuthError("Unregistered redirect URI");
            if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" ||
                !/^[A-Za-z0-9_-]{43}$/.test(required(params, "code_challenge")))
                throw new HostedOAuthError("Authorization code with S256 PKCE required");
            const resource = params.get("resource") ?? this.config.resource.toString();
            if (resource !== this.config.resource.toString()) throw new HostedOAuthError("Invalid resource");
            const scope = params.get("scope") ?? "modlens";
            if (scope !== "modlens") throw new HostedOAuthError("Unsupported scope", 400, "invalid_scope");
            const verifier = randomBytes(32).toString("base64url");
            const flowId = randomBytes(6).toString("hex");
            const state = await this.putObject("state", { flowId, clientId, callback, resource,
                challenge: params.get("code_challenge"), clientState: params.get("state") ?? "", verifier }, 600);
            this.audit("authorization_started", { flow: flowId, client: this.clientRef(clientId),
                redirectOrigin: new URL(callback).origin });
            const upstream = new URL(this.config.authorizeUrl);
            upstream.searchParams.set("response_type", "code");
            upstream.searchParams.set("client_id", this.config.clientId);
            upstream.searchParams.set("redirect_uri", this.callbackUrl());
            upstream.searchParams.set("scope", this.config.scopes);
            upstream.searchParams.set("state", state);
            upstream.searchParams.set("code_challenge", challenge(verifier));
            upstream.searchParams.set("code_challenge_method", "S256");
            redirect(res, upstream);
            return true;
        }
        if (route === "/oauth/upstream/callback" && req.method === "GET") {
            uniqueQuery(url.searchParams);
            const state = await this.takeObject(required(url.searchParams, "state"), "state") as {
                flowId: string; clientId: string; callback: string; resource: string; challenge: string;
                clientState: string; verifier: string;
            };
            this.audit("upstream_callback_received", { flow: state.flowId, client: this.clientRef(state.clientId),
                providerError: url.searchParams.has("error") });
            const callback = new URL(state.callback);
            if (url.searchParams.has("error")) {
                callback.searchParams.set("error", url.searchParams.get("error") ?? "access_denied");
            } else {
                const reportedIssuer = url.searchParams.get("iss");
                if ((this.config.requiresIss && !reportedIssuer) ||
                    (reportedIssuer && reportedIssuer !== this.config.issuer))
                    throw new HostedOAuthError("Provider issuer mismatch", 400, "invalid_grant", state.flowId);
                const values = new URLSearchParams({ grant_type: "authorization_code", code: required(url.searchParams, "code"),
                    redirect_uri: this.callbackUrl(), code_verifier: state.verifier });
                const upstream = await this.upstreamToken(values);
                const profile = await this.profile(upstream.access_token);
                if (!profile.allowed) throw new HostedOAuthError("Account access denied", 403, "access_denied");
                const approval = await this.putObject("approval", { ...state, upstream, subject: profile.subject }, 600);
                this.audit("consent_presented", { flow: state.flowId, client: this.clientRef(state.clientId),
                    redirectOrigin: callback.origin });
                const clientName = await this.clientName(state.clientId);
                const destination = escapeHtml(callback.toString());
                const content = `<h1>Allow access?</h1><p>The application below wants to connect to your hosted ModLens account.</p>`
                    + `<div class="app"><span class="app-icon" aria-hidden="true">&gt;_</span><span class="app-copy"><strong class="app-name">${clientName ? escapeHtml(clientName) : "Unnamed application"}</strong><small class="app-label">${clientName ? "Name supplied by application" : "No application name supplied"}</small></span></div>`
                    + `<details class="connection-details"><summary>Connection details</summary><p>After approval, ModLens returns you to this registered callback:</p><code class="callback-url">${destination}</code></details>`
                    + `<ul class="permissions"><li>Run hosted ModLens tools on your behalf</li><li>Use your hosted account allowance</li></ul>`
                    + `<form method="post" action="/oauth/approve"><input type="hidden" name="approval" value="${escapeHtml(approval)}"><div class="actions"><button class="secondary" name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="allow">Allow access</button></div></form>`
                    + `<p class="note">Only continue if you started this request in the app.</p>`;
                // Browsers may apply form-action to the redirect after approval as well as the POST.
                res.writeHead(200, { ...htmlHeaders,
                    "Content-Security-Policy": htmlCsp(`'self' ${callback.origin}`) });
                res.end(page("Connect", content));
                return true;
            }
            if (state.clientState) callback.searchParams.set("state", state.clientState);
            callback.searchParams.set("iss", this.issuerUrl());
            redirect(res, callback);
            return true;
        }
        if (route === "/oauth/approve" && req.method === "POST") {
            const params = form(await body(req));
            const approvalId = required(params, "approval");
            const decision = params.get("decision") === "allow" ? "allow" : "deny";
            let approval: {
                flowId: string; clientId: string; callback: string; resource: string; challenge: string; clientState: string;
                upstream: UpstreamTokens; subject: string;
            };
            try {
                approval = await this.takeObject(approvalId, "approval") as typeof approval;
            } catch (error) {
                const previous = await this.getObject(approvalId, "approval_result") as
                    { flowId: string; decision: string; callback: string } | undefined;
                if (!(error instanceof HostedOAuthError) || !previous || previous.decision !== decision) throw error;
                this.audit("consent_submission_retried", { flow: previous.flowId, decision });
                redirect(res, new URL(previous.callback));
                return true;
            }
            const callback = new URL(approval.callback);
            if (decision === "allow") {
                const code = await this.putObject("code", approval, 60);
                callback.searchParams.set("code", code);
            } else callback.searchParams.set("error", "access_denied");
            if (approval.clientState) callback.searchParams.set("state", approval.clientState);
            callback.searchParams.set("iss", this.issuerUrl());
            await this.putObjectAt(approvalId, "approval_result", { flowId: approval.flowId, decision,
                callback: callback.toString() }, 30);
            this.audit("consent_decided", { flow: approval.flowId, client: this.clientRef(approval.clientId), decision });
            redirect(res, callback);
            return true;
        }
        if (route === "/oauth/token" && req.method === "POST") {
            const requestRef = randomBytes(6).toString("hex");
            const responseAudit: Record<string, string | number | boolean | undefined> = { request: requestRef };
            this.observeTokenResponse(req, res, responseAudit);
            const params = form(await body(req));
            const clientId = required(params, "client_id");
            responseAudit.client = this.clientRef(clientId);
            await this.client(clientId);
            const grantType = required(params, "grant_type");
            responseAudit.grantType = grantType;
            this.audit("token_request_received", { request: requestRef, client: responseAudit.client, grantType });
            if (grantType === "authorization_code") {
                const code = await this.takeObject(required(params, "code"), "code") as {
                    flowId: string; clientId: string; callback: string; resource: string; challenge: string;
                    upstream: UpstreamTokens; subject: string;
                };
                if (code.clientId !== clientId || code.callback !== required(params, "redirect_uri") ||
                    challenge(required(params, "code_verifier")) !== code.challenge ||
                    (params.has("resource") && params.get("resource") !== code.resource))
                    throw new HostedOAuthError("Authorization code binding failed", 400, "invalid_grant", code.flowId);
                const grantId = token("mlg_");
                const refresh = code.upstream.refresh_token ? token("mlr_") : undefined;
                const grant: GrantRow = { id: grantId, client_id: clientId, subject: code.subject, resource: code.resource,
                    upstream_access: this.seal(code.upstream.access_token),
                    upstream_refresh: code.upstream.refresh_token ? this.seal(code.upstream.refresh_token) : null,
                    upstream_expires: now() + Math.max(1, Math.min(86400, Number(code.upstream.expires_in) || 300)),
                    refresh_hash: refresh ? sha(refresh) : null, refresh_expires: now() + 30 * 86400 };
                const db = await this.db();
                await db.$executeRawUnsafe(`INSERT INTO hosted_oauth_grants (id,client_id,subject,resource,upstream_access,upstream_refresh,
                    upstream_expires,refresh_hash,refresh_expires) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                    grant.id, grant.client_id, grant.subject, grant.resource, grant.upstream_access, grant.upstream_refresh,
                    grant.upstream_expires, grant.refresh_hash, grant.refresh_expires);
                const access = await this.issue(grant);
                const response = { ...access, ...(refresh ? { refresh_token: refresh } : {}) };
                this.audit("token_issued", { request: requestRef, flow: code.flowId, client: this.clientRef(clientId), refresh: !!refresh,
                    grant: this.grantRef(grant.id), accessExpiresIn: Number(access.expires_in),
                    ...(refresh ? { refreshRef: sha(refresh).slice(0, 12) } : {}) });
                Object.assign(responseAudit, this.describeTokenResponse(response));
                json(res, 200, response);
                return true;
            }
            if (grantType === "refresh_token") {
                if (params.has("resource") && params.get("resource") !== this.config.resource.toString())
                    throw new HostedOAuthError("Wrong resource", 400, "invalid_grant");
                if (params.has("scope") && params.get("scope") !== "modlens")
                    throw new HostedOAuthError("Unsupported scope", 400, "invalid_scope");
                const raw = required(params, "refresh_token");
                responseAudit.presentedRefreshRef = sha(raw).slice(0, 12);
                const key = `${clientId}:${sha(raw)}`;
                let pending = this.refreshes.get(key);
                if (!pending) {
                    this.audit("refresh_started", { request: requestRef, client: this.clientRef(clientId),
                        refreshRef: responseAudit.presentedRefreshRef });
                    pending = this.refresh(clientId, raw, requestRef);
                    this.refreshes.set(key, pending);
                    void pending.finally(() => this.refreshes.delete(key)).catch(() => {});
                } else this.audit("refresh_joined", { request: requestRef, client: this.clientRef(clientId),
                    refreshRef: responseAudit.presentedRefreshRef });
                const response = await pending;
                Object.assign(responseAudit, this.describeTokenResponse(response));
                json(res, 200, response);
                return true;
            }
            throw new HostedOAuthError("Unsupported grant type", 400, "unsupported_grant_type");
        }
        if (route === "/oauth/revoke" && req.method === "POST") {
            const params = form(await body(req));
            const clientId = required(params, "client_id");
            await this.client(clientId);
            const raw = required(params, "token");
            const db = await this.db();
            const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT id FROM hosted_oauth_grants WHERE client_id=$1 AND refresh_hash=$2`, clientId, sha(raw));
            if (rows.length) await this.revoke(rows[0].id, "client_request");
            else {
                const access = await db.$queryRawUnsafe<Array<{ id: string }>>(
                    `SELECT g.id FROM hosted_oauth_access a JOIN hosted_oauth_grants g ON g.id=a.grant_id
                     WHERE g.client_id=$1 AND a.token_hash=$2`, clientId, sha(raw));
                if (access.length) await this.revoke(access[0].id, "client_request");
            }
            json(res, 200, {});
            return true;
        }
        return false;
    }

    private metadataUrlPath(): string { return new URL(this.metadataUrl()).pathname; }
}
