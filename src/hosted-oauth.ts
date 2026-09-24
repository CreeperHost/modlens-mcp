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
    key: Buffer; authorizeUrl: string; tokenUrl: string; requiresIss: boolean;
};

export class HostedOAuthError extends Error {
    constructor(message: string, public status = 400, public code = "invalid_request") { super(message); }
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (prefix: string) => prefix + randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(value));
};
const redirect = (res: ServerResponse, url: URL) => {
    res.writeHead(302, { Location: url.toString(), "Cache-Control": "no-store" });
    res.end();
};
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

export class HostedOAuth {
    private ready?: Promise<void>;
    private requestCounts = new Map<string, { minute: number; count: number }>();
    private constructor(private config: AuthConfig, private database: () => Promise<Database>) {}

    static async create(env: NodeJS.ProcessEnv = process.env, database: () => Promise<Database> = getDb): Promise<HostedOAuth> {
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
        const metadataUrl = new URL(`/.well-known/oauth-authorization-server${path === "/" ? "" : path}`, issuer);
        let response = await fetch(metadataUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
        if (response.status === 404) response = await fetch(new URL(".well-known/openid-configuration", issuer + "/"),
            { redirect: "error", signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("OAuth provider metadata unavailable");
        const metadata = await response.json() as Record<string, unknown>;
        if (metadata.issuer !== issuer) throw new Error("OAuth provider issuer mismatch");
        const authorizeUrl = secureUrl(String(metadata.authorization_endpoint ?? ""), "authorization endpoint", true).toString();
        const tokenUrl = secureUrl(String(metadata.token_endpoint ?? ""), "token endpoint", true).toString();
        const profileUrl = secureUrl(String(env.MODLENS_OAUTH_PROFILE_URL ?? metadata.userinfo_endpoint ?? ""),
            "MODLENS_OAUTH_PROFILE_URL", true).toString();
        const instance = new HostedOAuth({ resource, issuer, clientId, clientSecret: env.MODLENS_OAUTH_CLIENT_SECRET,
            scopes, profileUrl, subjectField, requiredField, requiredValue: env.MODLENS_OAUTH_REQUIRED_VALUE,
            key, authorizeUrl, tokenUrl, requiresIss: metadata.authorization_response_iss_parameter_supported === true }, database);
        await instance.db();
        return instance;
    }

    private async db(): Promise<Database> {
        const db = await this.database();
        if (!this.ready) this.ready = (async () => {
            await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hosted_oauth_clients (
                id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, created BIGINT NOT NULL)`);
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

    private async takeObject(id: string, kind: string): Promise<unknown> {
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<RecordRow[]>(`DELETE FROM hosted_oauth_objects
            WHERE id=$1 AND kind=$2 AND expires>$3 RETURNING id,kind,payload,expires`, sha(id), kind, now());
        if (rows.length !== 1) throw new HostedOAuthError("Expired or reused authorization", 400, "invalid_grant");
        return JSON.parse(this.open(rows[0].payload));
    }

    private async client(clientId: string): Promise<string[]> {
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<Array<{ redirect_uris: string }>>(
            `SELECT redirect_uris FROM hosted_oauth_clients WHERE id=$1`, clientId);
        if (rows.length !== 1) throw new HostedOAuthError("Unknown OAuth client", 400, "invalid_client");
        return JSON.parse(rows[0].redirect_uris);
    }

    private async upstreamToken(values: URLSearchParams): Promise<UpstreamTokens> {
        const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
        values.set("client_id", this.config.clientId);
        if (this.config.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
        let response: Response;
        try { response = await fetch(this.config.tokenUrl, { method: "POST", headers, body: values,
            redirect: "error", signal: AbortSignal.timeout(10000) }); }
        catch { throw new HostedOAuthError("Provider token endpoint unavailable", 503, "temporarily_unavailable"); }
        if (!response.ok) throw new HostedOAuthError("Provider token exchange failed", response.status >= 500 ? 503 : 401, "invalid_grant");
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
        if (!response.ok) throw new HostedOAuthError("Provider profile unavailable", response.status === 401 || response.status === 403 ? 401 : 503,
            response.status === 401 || response.status === 403 ? "invalid_token" : "temporarily_unavailable");
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

    async authenticate(req: IncomingMessage): Promise<string> {
        for (const name of Object.keys(req.headers)) if (name.startsWith("x-modlens-"))
            throw new HostedOAuthError("Gateway headers are not accepted in OAuth mode", 401, "invalid_token");
        const value = req.headers.authorization;
        if (typeof value !== "string" || !/^Bearer m[a-z]+_[A-Za-z0-9_-]{43}$/.test(value))
            throw new HostedOAuthError("Bearer token required", 401, "invalid_token");
        const raw = value.slice(7);
        const db = await this.db();
        const rows = await db.$queryRawUnsafe<Array<GrantRow & { access_expires: bigint | number }>>(
            `SELECT g.*, a.expires AS access_expires FROM hosted_oauth_access a
             JOIN hosted_oauth_grants g ON g.id=a.grant_id WHERE a.token_hash=$1 AND a.expires>$2`, sha(raw), now());
        if (rows.length !== 1 || rows[0].resource !== this.config.resource.toString())
            throw new HostedOAuthError("Invalid access token", 401, "invalid_token");
        const grant = rows[0];
        if (Number(grant.upstream_expires) <= now()) throw new HostedOAuthError("Access token expired", 401, "invalid_token");
        try {
            const profile = await this.profile(this.open(grant.upstream_access));
            if (!profile.allowed || profile.subject !== grant.subject) {
                await this.revoke(grant.id);
                throw new HostedOAuthError("Account access denied", 403, "access_denied");
            }
        } catch (error) {
            if (error instanceof HostedOAuthError && error.status === 401) await this.revoke(grant.id);
            throw error;
        }
        return sha(this.config.issuer + "\0" + grant.subject);
    }

    private async revoke(id: string): Promise<void> {
        const db = await this.db();
        await db.$executeRawUnsafe(`DELETE FROM hosted_oauth_access WHERE grant_id=$1`, id);
        await db.$executeRawUnsafe(`DELETE FROM hosted_oauth_grants WHERE id=$1`, id);
    }

    private async issue(grant: GrantRow): Promise<Record<string, unknown>> {
        const rawAccess = token("mla_");
        const expires = Math.max(1, Math.min(300, Number(grant.upstream_expires) - now() - 5));
        const db = await this.db();
        await db.$executeRawUnsafe(`INSERT INTO hosted_oauth_access (token_hash,grant_id,expires) VALUES ($1,$2,$3)`,
            sha(rawAccess), grant.id, now() + expires);
        return { access_token: rawAccess, token_type: "Bearer", expires_in: expires, scope: "modlens" };
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
            const id = token("mlc_");
            const db = await this.db();
            await db.$executeRawUnsafe(`INSERT INTO hosted_oauth_clients (id,redirect_uris,created) VALUES ($1,$2,$3)`,
                id, JSON.stringify(redirects), now());
            json(res, 201, { client_id: id, redirect_uris: redirects, grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"], token_endpoint_auth_method: "none" });
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
            const state = await this.putObject("state", { clientId, callback, resource,
                challenge: params.get("code_challenge"), clientState: params.get("state") ?? "", verifier }, 600);
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
                clientId: string; callback: string; resource: string; challenge: string; clientState: string; verifier: string;
            };
            const callback = new URL(state.callback);
            if (url.searchParams.has("error")) {
                callback.searchParams.set("error", url.searchParams.get("error") ?? "access_denied");
            } else {
                const reportedIssuer = url.searchParams.get("iss");
                if ((this.config.requiresIss && !reportedIssuer) ||
                    (reportedIssuer && reportedIssuer !== this.config.issuer))
                    throw new HostedOAuthError("Provider issuer mismatch", 400, "invalid_grant");
                const values = new URLSearchParams({ grant_type: "authorization_code", code: required(url.searchParams, "code"),
                    redirect_uri: this.callbackUrl(), code_verifier: state.verifier });
                const upstream = await this.upstreamToken(values);
                const profile = await this.profile(upstream.access_token);
                if (!profile.allowed) throw new HostedOAuthError("Account access denied", 403, "access_denied");
                const approval = await this.putObject("approval", { ...state, upstream, subject: profile.subject }, 600);
                const destination = callback.origin.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
                    "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
                res.end(`<!doctype html><html><meta charset="utf-8"><title>Connect to ModLens</title><body><h1>Connect to ModLens</h1><p>Allow the application at <strong>${destination}</strong> to use your hosted ModLens access?</p><form method="post" action="/oauth/approve"><input type="hidden" name="approval" value="${approval}"><button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form></body></html>`);
                return true;
            }
            if (state.clientState) callback.searchParams.set("state", state.clientState);
            callback.searchParams.set("iss", this.issuerUrl());
            redirect(res, callback);
            return true;
        }
        if (route === "/oauth/approve" && req.method === "POST") {
            const params = form(await body(req));
            const approval = await this.takeObject(required(params, "approval"), "approval") as {
                clientId: string; callback: string; resource: string; challenge: string; clientState: string;
                upstream: UpstreamTokens; subject: string;
            };
            const callback = new URL(approval.callback);
            if (params.get("decision") === "allow") {
                const code = await this.putObject("code", approval, 60);
                callback.searchParams.set("code", code);
            } else callback.searchParams.set("error", "access_denied");
            if (approval.clientState) callback.searchParams.set("state", approval.clientState);
            callback.searchParams.set("iss", this.issuerUrl());
            redirect(res, callback);
            return true;
        }
        if (route === "/oauth/token" && req.method === "POST") {
            const params = form(await body(req));
            const clientId = required(params, "client_id");
            await this.client(clientId);
            const grantType = required(params, "grant_type");
            if (grantType === "authorization_code") {
                const code = await this.takeObject(required(params, "code"), "code") as {
                    clientId: string; callback: string; resource: string; challenge: string; upstream: UpstreamTokens; subject: string;
                };
                if (code.clientId !== clientId || code.callback !== required(params, "redirect_uri") ||
                    challenge(required(params, "code_verifier")) !== code.challenge ||
                    (params.has("resource") && params.get("resource") !== code.resource))
                    throw new HostedOAuthError("Authorization code binding failed", 400, "invalid_grant");
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
                json(res, 200, { ...await this.issue(grant), ...(refresh ? { refresh_token: refresh } : {}) });
                return true;
            }
            if (grantType === "refresh_token") {
                if (params.has("resource") && params.get("resource") !== this.config.resource.toString())
                    throw new HostedOAuthError("Wrong resource", 400, "invalid_grant");
                if (params.has("scope") && params.get("scope") !== "modlens")
                    throw new HostedOAuthError("Unsupported scope", 400, "invalid_scope");
                const raw = required(params, "refresh_token");
                const db = await this.db();
                const rows = await db.$queryRawUnsafe<GrantRow[]>(`UPDATE hosted_oauth_grants SET refresh_hash=NULL
                    WHERE refresh_hash=$1 AND client_id=$2 AND refresh_expires>$3 RETURNING *`, sha(raw), clientId, now());
                if (rows.length !== 1 || !rows[0].upstream_refresh) throw new HostedOAuthError("Invalid refresh token", 400, "invalid_grant");
                const grant = rows[0];
                try {
                    const oldUpstreamRefresh = grant.upstream_refresh!;
                    const upstream = await this.upstreamToken(new URLSearchParams({ grant_type: "refresh_token",
                        refresh_token: this.open(oldUpstreamRefresh) }));
                    grant.upstream_access = this.seal(upstream.access_token);
                    grant.upstream_refresh = this.seal(upstream.refresh_token ?? this.open(oldUpstreamRefresh));
                    grant.upstream_expires = now() + Math.max(1, Math.min(86400, Number(upstream.expires_in) || 300));
                    await db.$executeRawUnsafe(`UPDATE hosted_oauth_grants SET upstream_access=$2,upstream_refresh=$3,
                        upstream_expires=$4 WHERE id=$1`, grant.id, grant.upstream_access,
                        grant.upstream_refresh, grant.upstream_expires);
                    const profile = await this.profile(upstream.access_token);
                    if (profile.subject !== grant.subject || !profile.allowed) throw new HostedOAuthError("Account access denied", 403, "access_denied");
                    const next = token("mlr_");
                    grant.refresh_hash = sha(next);
                    await db.$executeRawUnsafe(`UPDATE hosted_oauth_grants SET refresh_hash=$2 WHERE id=$1`, grant.id, grant.refresh_hash);
                    json(res, 200, { ...await this.issue(grant), refresh_token: next });
                } catch (error) {
                    if (error instanceof HostedOAuthError && error.status === 503) {
                        await db.$executeRawUnsafe(`UPDATE hosted_oauth_grants SET refresh_hash=$2 WHERE id=$1 AND refresh_hash IS NULL`, grant.id, sha(raw));
                    } else await this.revoke(grant.id);
                    throw error;
                }
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
            if (rows.length) await this.revoke(rows[0].id);
            else {
                const access = await db.$queryRawUnsafe<Array<{ id: string }>>(
                    `SELECT g.id FROM hosted_oauth_access a JOIN hosted_oauth_grants g ON g.id=a.grant_id
                     WHERE g.client_id=$1 AND a.token_hash=$2`, clientId, sha(raw));
                if (access.length) await this.revoke(access[0].id);
            }
            json(res, 200, {});
            return true;
        }
        return false;
    }

    private metadataUrlPath(): string { return new URL(this.metadataUrl()).pathname; }
}
