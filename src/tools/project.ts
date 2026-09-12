/** Project compile environments. Deliberately independent of the shared mod/MC database. */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rename, rm, stat, open } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import AdmZip from "adm-zip";
import { z } from "zod";
import { CACHE_ROOT } from "../cache.js";
import { assertHostAccessiblePath, normalizeJarPath } from "../security.js";
import { decompileClass, inspectClass, getBytecode } from "../java-tools.js";

const MB = 1024 * 1024;
export const PROJECT_CHUNK_BYTES = MB;
const MAX_BUNDLE = 512 * MB;
const MAX_EXPANDED = 1024 * MB;
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const artifactSchema = z.object({
    path: z.string().regex(/^artifacts\/[0-9]+\.jar$/),
    name: z.string().min(1).max(300),
    sha256: hex,
    size: z.number().int().positive().max(MAX_BUNDLE),
    // classpath order is authoritative; source JARs must name the binary they describe.
    kind: z.enum(["classpath", "sources"]),
    sourceFor: z.string().regex(/^artifacts\/[0-9]+\.jar$/).optional(),
}).strict();
export const projectManifestSchema = z.object({
    format: z.literal("modlens-project-v1"),
    project: z.string().min(1).max(300),
    sourceSet: z.string().min(1).max(100),
    toolchain: z.string().min(1).max(200),
    minecraftVersion: z.string().max(100),
    loaderVersion: z.string().max(100),
    mappings: z.string().max(300),
    javaVersion: z.number().int().min(8).max(100),
    // Hashes only: no absolute paths, credentials or Gradle properties are exported.
    transformations: z.array(z.object({ name: z.string().max(300), sha256: hex }).strict()).max(1000),
    artifacts: z.array(artifactSchema).min(1).max(2000),
}).strict();
type Manifest = z.infer<typeof projectManifestSchema>;
type ClassEntry = { artifact: string; entry: string; effectiveArtifact?: string };
type SourceEntry = { artifact: string; entry: string; binary: string };
type Index = { classes: Record<string, ClassEntry>; sources: Record<string, SourceEntry>; shadowedClasses: number };
type Snapshot = { environmentId: string; importedAt: string; manifest: Manifest; index: Index };

// No tool can enumerate other projects. A random 256-bit projectKey is the access capability.
// Only its hash is used on disk; never return it in tool output or log it.
function projectRoot(root: string, key: string): string {
    if (!hex.safeParse(key).success) throw new Error("projectKey must be a random 64-character lowercase hex key (use the export task's project-key.txt).");
    return join(root, digest(key));
}
function identifier(value: string | undefined, label: string): string {
    if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
    return value;
}
function safeEntry(name: string): boolean {
    return !name.includes("\\") && !name.includes(":") && !name.startsWith("/") &&
        !name.split("/").some(p => p === ".." || p === "." || /[\x00-\x1f]/.test(p));
}
function className(value: string | undefined): string {
    const name = (value ?? "").replace(/\.class$/, "").replace(/\./g, "/");
    if (!name || name.length > 500 || !name.split("/").every(p => /^[\p{L}\p{N}_$]+$/u.test(p))) throw new Error("Invalid className");
    return name;
}
function readZip(data: Buffer, maxTotal: number): AdmZip {
    const zip = new AdmZip(data);
    let size = 0;
    const names = new Set<string>();
    const entries = zip.getEntries();
    if (entries.length > 250_000) throw new Error("Archive has too many entries");
    for (const entry of entries) {
        if (!safeEntry(entry.entryName) || names.has(entry.entryName)) throw new Error("Unsafe or duplicate archive entry");
        names.add(entry.entryName);
        size += entry.header.size;
        if (size > maxTotal) throw new Error("Archive exceeds expanded size limit");
        // We never extract ZIP paths, and never follow symlinks from archives.
        if (((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error("Archive symlinks are unsupported");
    }
    return zip;
}
function entryData(zip: AdmZip, name: string, max: number): Buffer {
    const entry = zip.getEntry(name);
    if (!entry || entry.isDirectory || entry.header.size > max) throw new Error(`Missing or oversized archive entry: ${name}`);
    const data = entry.getData();
    if (data.length !== entry.header.size || data.length > max) throw new Error("Archive entry size mismatch");
    return data;
}

/** Serializes operations for the same upload in this server process; immutable commits use rename. */
const locks = new Map<string, Promise<unknown>>();
async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = locks.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    locks.set(key, next);
    try { return await next; }
    finally { if (locks.get(key) === next) locks.delete(key); }
}

export class ProjectStore {
    constructor(readonly root = join(CACHE_ROOT, "projects")) {}

    private dir(key: string, environmentId: string) {
        return join(projectRoot(this.root, key), "environments", identifier(environmentId, "environmentId"));
    }

    async snapshot(key: string, environmentId: string): Promise<Snapshot> {
        try { return JSON.parse(await readFile(join(this.dir(key, environmentId), "snapshot.json"), "utf8")); }
        catch { throw new Error("Project environment not found for this projectKey; import a bundle first."); }
    }

    async list(key: string) {
        const root = join(projectRoot(this.root, key), "environments");
        const ids = await readdir(root).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
        return Promise.all(ids.filter(id => /^[a-f0-9]{64}$/.test(id)).sort().map(async id => this.describe(key, id)));
    }

    async describe(key: string, environmentId: string) {
        const s = await this.snapshot(key, environmentId);
        return { environmentId, importedAt: s.importedAt, ...s.manifest,
            classCount: Object.keys(s.index.classes).length, sourceCount: Object.keys(s.index.sources).length,
            shadowedClasses: s.index.shadowedClasses,
            scope: "Gradle compile-time snapshot; runtime mixin/coremod transformations are not applied. Re-export after build configuration changes." };
    }

    async importLocal(key: string, bundlePath: string) {
        // Remote clients must use upload chunks; no remote arbitrary host filesystem import.
        if (process.env.MCP_PORT) throw new Error("import_local is disabled over HTTP; use the upload client.");
        const path = normalizeJarPath(bundlePath);
        assertHostAccessiblePath(path);
        if (!isAbsolute(path) || !path.endsWith(".zip")) throw new Error("bundlePath must be an absolute .zip path on the ModLens host");
        if ((await stat(path)).size > MAX_BUNDLE) throw new Error("Bundle exceeds 512 MiB limit");
        return this.importBuffer(key, await readFile(path));
    }

    async importBuffer(key: string, data: Buffer) {
        const root = projectRoot(this.root, key);
        if (!data.length || data.length > MAX_BUNDLE) throw new Error("Bundle exceeds 512 MiB limit");
        const zip = readZip(data, MAX_BUNDLE);
        const manifest = projectManifestSchema.parse(JSON.parse(entryData(zip, "manifest.json", 2 * MB).toString("utf8")));
        const paths = new Set(manifest.artifacts.map(a => a.path));
        if (paths.size !== manifest.artifacts.length) throw new Error("Duplicate artifact paths");
        if (zip.getEntries().some(e => !e.isDirectory && e.entryName !== "manifest.json" && !paths.has(e.entryName))) throw new Error("Undeclared bundle entry");
        for (const a of manifest.artifacts) {
            if (a.kind === "sources" && !manifest.artifacts.some(b => b.kind === "classpath" && b.path === a.sourceFor)) throw new Error("Source artifact must reference a classpath artifact");
            if (a.kind === "classpath" && a.sourceFor) throw new Error("Classpath artifact cannot have sourceFor");
        }
        // Canonical schema property order and artifact order make the ID independent of ZIP timestamps.
        const environmentId = digest(JSON.stringify(manifest));
        const dest = this.dir(key, environmentId);
        const stage = join(root, "staging", randomBytes(32).toString("hex"));
        await mkdir(join(stage, "artifacts"), { recursive: true });
        const index: Index = { classes: Object.create(null), sources: Object.create(null), shadowedClasses: 0 };
        const candidates: Array<{ name: string; source: SourceEntry }> = [];
        const overlaidSources = new Set<string>();
        let totalExpanded = 0;
        try {
            for (const artifact of manifest.artifacts) {
                const bytes = entryData(zip, artifact.path, MAX_BUNDLE);
                if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256) throw new Error(`Artifact checksum mismatch: ${artifact.path}`);
                const jar = readZip(bytes, MAX_EXPANDED - totalExpanded);
                const entries = jar.getEntries();
                const overlays = new Map<string, { version: number; entry: string }>();
                const multiRelease = jar.getEntry("META-INF/MANIFEST.MF") && /^Multi-Release:\s*true\s*$/im.test(entryData(jar, "META-INF/MANIFEST.MF", MB).toString("utf8"));
                if (multiRelease && artifact.kind === "classpath") {
                    for (const e of entries) {
                        const match = /^META-INF\/versions\/(\d+)\/(.+\.class)$/.exec(e.entryName);
                        if (!match || Number(match[1]) < 9 || Number(match[1]) > manifest.javaVersion) continue;
                        if (e.header.size > 16 * MB) throw new Error("Oversized class file");
                        const current = overlays.get(match[2]);
                        if (!current || Number(match[1]) > current.version) overlays.set(match[2], { version: Number(match[1]), entry: e.entryName });
                    }
                }
                for (const e of entries) {
                    totalExpanded += e.header.size;
                    if (e.isDirectory || e.entryName.startsWith("META-INF/")) continue;
                    if (e.entryName.endsWith(".class") && artifact.kind === "classpath") {
                        if (e.header.size > 16 * MB) throw new Error("Oversized class file");
                        const name = e.entryName.slice(0, -6);
                        if (name === "module-info" || name.endsWith("/package-info")) continue;
                        className(name);
                        if (index.classes[name]) index.shadowedClasses++;
                        else index.classes[name] = { artifact: artifact.path, entry: e.entryName };
                    } else if (e.entryName.endsWith(".java")) {
                        if (e.header.size > 2 * MB) throw new Error("Oversized Java source file");
                        candidates.push({ name: e.entryName.slice(0, -5), source: {
                            artifact: artifact.path, entry: e.entryName, binary: artifact.sourceFor ?? artifact.path,
                        } });
                    }
                }
                if (overlays.size) {
                    // javap/indexer/decompiler must all inspect the same Java-release-specific view.
                    const effectiveArtifact = artifact.path.replace("artifacts/", "effective/");
                    for (const [name, selected] of overlays) {
                        const logical = name.slice(0, -6);
                        if (logical === "module-info" || logical.endsWith("/package-info")) continue;
                        className(logical);
                        if (!index.classes[logical] || index.classes[logical].artifact === artifact.path) {
                            index.classes[logical] = { artifact: artifact.path, entry: selected.entry, effectiveArtifact };
                            overlaidSources.add(`${artifact.path}:${logical.split("$")[0]}`);
                        }
                        const data = entryData(jar, selected.entry, 16 * MB);
                        if (jar.getEntry(name)) jar.updateFile(name, data); else jar.addFile(name, data);
                    }
                    for (const e of entries) if (e.entryName.startsWith("META-INF/versions/")) jar.deleteFile(e.entryName);
                    await mkdir(join(stage, "effective"), { recursive: true });
                    await writeFile(join(stage, effectiveArtifact), jar.toBuffer());
                    // Even non-overlaid classes in this JAR use the flattened artifact consistently.
                    for (const entry of Object.values(index.classes)) if (entry.artifact === artifact.path) entry.effectiveArtifact = effectiveArtifact;
                }
                await writeFile(join(stage, artifact.path), bytes, { flag: "wx" });
            }
            if (!Object.keys(index.classes).length) throw new Error("Bundle contains no compile classpath classes");
            for (const c of candidates) {
                // A duplicate dependency's sources must never describe the winning class.
                const binary = index.classes[c.name];
                if (binary?.artifact === c.source.binary && !overlaidSources.has(`${c.source.binary}:${c.name.split("$")[0]}`) && !index.sources[c.name]) index.sources[c.name] = c.source;
            }
            const snapshot: Snapshot = { environmentId, importedAt: new Date().toISOString(), manifest, index };
            await writeFile(join(stage, "snapshot.json"), JSON.stringify(snapshot));
            await mkdir(join(root, "environments"), { recursive: true });
            await exclusive(dest, async () => {
                try { await stat(join(dest, "snapshot.json")); }
                catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; await rename(stage, dest); }
            });
            return this.describe(key, environmentId);
        } finally { await rm(stage, { recursive: true, force: true }); }
    }

    private uploadDir(key: string, uploadId: string) {
        return join(projectRoot(this.root, key), "uploads", identifier(uploadId, "uploadId"));
    }

    async begin(key: string, size: number, sha256: string) {
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BUNDLE) throw new Error("Upload size must be 1 byte to 512 MiB");
        identifier(sha256, "sha256");
        const root = join(projectRoot(this.root, key), "uploads");
        return exclusive(root, async () => {
            await mkdir(root, { recursive: true });
            // Bound abandoned uploads; expires after 24 hours. Cleanup only under this project's upload root.
            for (const id of await readdir(root)) {
                if (!/^[a-f0-9]{64}$/.test(id)) continue;
                const p = join(root, id);
                if (Date.now() - (await stat(p)).mtimeMs > 86400_000) await rm(p, { recursive: true, force: true });
            }
            let active = 0;
            for (const id of await readdir(root)) {
                if (!/^[a-f0-9]{64}$/.test(id)) continue;
                try { await stat(join(root, id, "receipt.json")); }
                catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; active++; }
            }
            if (active >= 4) throw new Error("At most four active uploads per project; abort an old upload first");
            const uploadId = randomBytes(32).toString("hex");
            const dir = this.uploadDir(key, uploadId);
            await mkdir(dir);
            await writeFile(join(dir, "metadata.json"), JSON.stringify({ size, sha256 }));
            await writeFile(join(dir, "bundle.zip"), Buffer.alloc(0));
            return { uploadId, chunkBytes: PROJECT_CHUNK_BYTES, offset: 0 };
        });
    }

    async chunk(key: string, uploadId: string, offset: number, base64: string) {
        const dir = this.uploadDir(key, uploadId);
        return exclusive(dir, async () => {
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
            if (!base64 || base64.length > Math.ceil(PROJECT_CHUNK_BYTES / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid or oversized base64 chunk");
            const bytes = Buffer.from(base64, "base64");
            if (!bytes.length || bytes.length > PROJECT_CHUNK_BYTES || bytes.toString("base64") !== base64) throw new Error("Chunk exceeds 1 MiB or is not canonical base64");
            const meta = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8"));
            const file = await open(join(dir, "bundle.zip"), "r+");
            try {
                const current = (await file.stat()).size;
                if (offset + bytes.length > meta.size || offset > current) throw new Error(`Unexpected offset; server has ${current} bytes`);
                if (offset < current) {
                    if (offset + bytes.length > current) throw new Error("Chunk overlaps uploaded bytes");
                    const existing = Buffer.alloc(bytes.length);
                    await file.read(existing, 0, existing.length, offset);
                    if (!existing.equals(bytes)) throw new Error("Retry does not match uploaded bytes");
                    return { offset: current };
                }
                let written = 0;
                while (written < bytes.length) written += (await file.write(bytes, written, bytes.length - written, offset + written)).bytesWritten;
                return { offset: offset + written };
            } finally { await file.close(); }
        });
    }

    async finish(key: string, uploadId: string) {
        const dir = this.uploadDir(key, uploadId);
        return exclusive(dir, async () => {
            // Retain receipt until expiry, so retrying a lost finish response is safe.
            try { return JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
            const meta = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8"));
            const data = await readFile(join(dir, "bundle.zip"));
            if (data.length !== meta.size || digest(data) !== meta.sha256) throw new Error("Upload incomplete or checksum mismatch");
            const result = await this.importBuffer(key, data);
            await writeFile(join(dir, "receipt.json"), JSON.stringify(result));
            await rm(join(dir, "bundle.zip"));
            return result;
        });
    }

    async abort(key: string, uploadId: string) {
        const dir = this.uploadDir(key, uploadId);
        await exclusive(dir, () => rm(dir, { recursive: true, force: true }));
        return { aborted: true };
    }

    async classes(key: string, environmentId: string, query = "", offset = 0, limit = 50) {
        const s = await this.snapshot(key, environmentId);
        const names = Object.keys(s.index.classes).filter(n => n.toLowerCase().includes(query.toLowerCase().replace(/\./g, "/"))).sort();
        return { environmentId, total: names.length, classes: names.slice(offset, offset + limit).map(name => ({ name, ...s.index.classes[name] })) };
    }

    async source(key: string, environmentId: string, input: string, startLine = 1, maxLines = 200) {
        const s = await this.snapshot(key, environmentId);
        const name = className(input);
        const binary = s.index.classes[name];
        if (!binary) throw new Error("Class is not in this environment's compile classpath");
        const outer = name.split("$")[0];
        const source = s.index.sources[name] ?? s.index.sources[outer];
        const dir = this.dir(key, environmentId);
        let text: string;
        let origin: string;
        if (source && source.binary === binary.artifact) {
            const zip = new AdmZip(await readFile(join(dir, source.artifact)));
            text = entryData(zip, source.entry, 2 * MB).toString("utf8");
            origin = "gradle-sources";
        } else {
            const cache = join(dir, "decompiled", binary.artifact.slice("artifacts/".length, -4));
            const path = join(cache, `${outer}.java`);
            text = await exclusive(path, async () => {
                try { return await readFile(path, "utf8"); }
                catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
                return decompileClass(join(dir, binary.effectiveArtifact ?? binary.artifact), outer, cache);
            });
            origin = "decompiled-compile-classpath";
        }
        const lines = text.split(/\r?\n/);
        return { environmentId, className: name, artifact: binary.artifact, origin, totalLines: lines.length, startLine,
            source: lines.slice(startLine - 1, startLine - 1 + maxLines).join("\n") };
    }

    async members(key: string, environmentId: string, input: string, bytecode = false) {
        const s = await this.snapshot(key, environmentId);
        const name = className(input);
        const binary = s.index.classes[name];
        if (!binary) throw new Error("Class is not in this environment's compile classpath");
        const path = join(this.dir(key, environmentId), binary.effectiveArtifact ?? binary.artifact);
        return { environmentId, className: name, artifact: binary.artifact,
            result: await (bytecode ? getBytecode(path, name) : inspectClass(path, name)) };
    }

    async search(key: string, environmentId: string, query: string, limit = 20) {
        if (!query || query.length > 500) throw new Error("query must contain 1 to 500 characters");
        const s = await this.snapshot(key, environmentId);
        const dir = this.dir(key, environmentId);
        const results: Array<{ className: string; line: number; text: string; origin: string }> = [];
        const needle = query.toLowerCase();
        let searchedFiles = 0;
        const byArtifact = new Map<string, Array<[string, SourceEntry]>>();
        for (const entry of Object.entries(s.index.sources)) {
            const group = byArtifact.get(entry[1].artifact) ?? [];
            group.push(entry); byArtifact.set(entry[1].artifact, group);
        }
        const searchText = (name: string, text: string, origin: string) => {
            searchedFiles++;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && results.length < limit; i++) {
                if (lines[i].toLowerCase().includes(needle)) results.push({ className: name, line: i + 1, text: lines[i].slice(0, 2000), origin });
            }
        };
        for (const [artifact, entries] of byArtifact) {
            if (results.length >= limit) break;
            const jar = new AdmZip(await readFile(join(dir, artifact)));
            for (const [name, source] of entries) {
                searchText(name, entryData(jar, source.entry, 2 * MB).toString("utf8"), "gradle-sources");
                if (results.length >= limit) break;
            }
        }
        // Include on-demand decompiles, but do not trigger an expensive full classpath decompile during search.
        const walkCached = async (base: string, prefix = ""): Promise<void> => {
            const entries = await readdir(join(base, prefix), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
                if (e.code === "ENOENT") return []; throw e;
            });
            for (const entry of entries) {
                if (results.length >= limit) return;
                const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) await walkCached(base, relative);
                else if (entry.isFile() && relative.endsWith(".java")) {
                    const name = relative.slice(0, -5);
                    if (!s.index.sources[name] && s.index.classes[name]) searchText(name, await readFile(join(base, relative), "utf8"), "decompiled-compile-classpath");
                }
            }
        };
        for (const a of s.manifest.artifacts) {
            if (a.kind !== "classpath" || results.length >= limit) continue;
            await walkCached(join(dir, "decompiled", a.path.slice("artifacts/".length, -4)));
        }
        return { environmentId, results, searchedFiles, limitReached: results.length >= limit,
            coverage: "Supplied Gradle sources and cached on-demand decompiles only. Use classes/members for the full compile classpath." };
    }
}

export const projectToolSchema = {
    action: z.enum(["import_local", "upload_begin", "upload_chunk", "upload_finish", "upload_abort", "list", "info", "classes", "source", "search", "members", "bytecode"]),
    projectKey: hex.describe("Private project access key from .gradle/modlens/project-key.txt. Never share or log it."),
    environmentId: hex.optional().describe("Immutable snapshot ID returned by import/list; required for queries."),
    bundlePath: z.string().optional(),
    uploadId: hex.optional(), size: z.number().int().positive().max(MAX_BUNDLE).optional(), sha256: hex.optional(),
    offset: z.number().int().min(0).optional(),
    data: z.string().max(Math.ceil(PROJECT_CHUNK_BYTES / 3) * 4).optional().describe("Base64 upload chunk (at most 1 MiB decoded)."),
    className: z.string().max(500).optional(), query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(200).optional(), startLine: z.number().int().min(1).optional(), maxLines: z.number().int().min(1).max(1000).optional(),
};
const requestSchema = z.object(projectToolSchema);
export type ProjectRequest = z.infer<typeof requestSchema>;
const defaultStore = new ProjectStore();
export async function projectAction(input: ProjectRequest, store = defaultStore): Promise<unknown> {
    const p = requestSchema.parse(input);
    const required = <T>(value: T | undefined, name: string): T => { if (value === undefined) throw new Error(`${name} is required for ${p.action}`); return value; };
    const key = p.projectKey;
    const env = () => required(p.environmentId, "environmentId");
    switch (p.action) {
        case "import_local": return store.importLocal(key, required(p.bundlePath, "bundlePath"));
        case "upload_begin": return store.begin(key, required(p.size, "size"), required(p.sha256, "sha256"));
        case "upload_chunk": return store.chunk(key, required(p.uploadId, "uploadId"), required(p.offset, "offset"), required(p.data, "data"));
        case "upload_finish": return store.finish(key, required(p.uploadId, "uploadId"));
        case "upload_abort": return store.abort(key, required(p.uploadId, "uploadId"));
        case "list": return store.list(key);
        case "info": return store.describe(key, env());
        case "classes": return store.classes(key, env(), p.query, p.offset, p.limit);
        case "source": return store.source(key, env(), required(p.className, "className"), p.startLine, p.maxLines);
        case "search": return store.search(key, env(), required(p.query, "query"), p.limit);
        case "members": return store.members(key, env(), required(p.className, "className"));
        case "bytecode": return store.members(key, env(), required(p.className, "className"), true);
    }
}
