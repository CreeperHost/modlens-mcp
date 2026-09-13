import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { createHash } from "crypto";
import { readdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";

vi.mock("./cache.js", async () => {
    const actual = await vi.importActual<typeof import("./cache.js")>("./cache.js");
    const { mkdtemp } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    return { ...actual, CACHE_ROOT: await mkdtemp(join(tmpdir(), "modlens-loader-fallback-")) };
});

import { CACHE_ROOT } from "./cache.js";
import { downloadModVersion } from "./mod-artifacts.js";
import { providerSearch, providerVersions, type ModVersion, type Target } from "./modpacks-ch.js";
import { getLatestFile } from "./curseforge.js";
import { getLatestVersion, getProjectVersions } from "./modrinth.js";

let projectId = 0;
let fileId = 100;
let requests: string[];
let artifacts: Map<string, Buffer>;
beforeEach(() => { projectId++; requests = []; artifacts = new Map(); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await rm(CACHE_ROOT, { recursive: true, force: true }); });

function target(type: string, name: string, version = ""): Target {
    return { id: 1, type, name, version, updated: 1 };
}

function version(options: { loader?: string; mcVersion?: string; files?: Record<string, string>; body?: Buffer } = {}): ModVersion {
    const id = ++fileId;
    const archive = new AdmZip();
    const files = options.files ?? { "mcmod.info": JSON.stringify([{ modid: "fixture", mcversion: options.mcVersion ?? "1.7.10" }]) };
    for (const [name, text] of Object.entries(files)) archive.addFile(name, Buffer.from(text));
    const body = options.body ?? archive.toBuffer();
    const url = `https://cdn.example.invalid/${id}.jar`;
    artifacts.set(url, body);
    return {
        id, name: `fixture-${id}.jar`, version: `${id}`, type: "Release", path: "mods/", url,
        sha1: createHash("sha1").update(body).digest("hex"), size: body.length, mirrors: [],
        clientonly: false, updated: id, dependencies: [],
        targets: [target("game", "minecraft", options.mcVersion ?? "1.7.10"),
            ...(options.loader ? [target("modloader", options.loader)] : [])],
    };
}

function serve(pages: ModVersion[][], api?: (url: string) => Response) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        requests.push(url);
        if (url.startsWith("https://api.modpacks.ch/public/")) {
            if (api) return api(url);
            const page = Number(url.split("/").at(-1));
            return Response.json({ pages: pages.length, versions: pages[page - 1] ?? [] });
        }
        const bytes = artifacts.get(url);
        if (!bytes) throw new Error(`Unexpected service: ${url}`);
        return new Response(new Uint8Array(bytes));
    }));
}

const downloads = () => requests.filter(url => url.startsWith("https://cdn.example.invalid/"));

describe("automatic loader recovery from mod artifacts", () => {
    it("uses existing labels without downloading matching or conflicting artifacts", async () => {
        const matching = version({ loader: "Forge" });
        const conflicting = version({ loader: "fabric" }); // Its JAR deliberately says Forge.
        serve([[conflicting, matching]]);
        expect(await providerVersions("mod", projectId, { loader: "FORGE", mcVersion: "1.7.10" })).toEqual([matching]);
        expect(downloads()).toEqual([]);
    });

    it.each(["1.6.4", "1.7.10", "1.8.9"])("recovers an unlabeled %s Forge file", async mcVersion => {
        const candidate = version({ mcVersion });
        serve([[candidate]]);
        const [found] = await providerVersions("mod", projectId, { loader: "forge", mcVersion });
        expect(found).toMatchObject({ id: candidate.id, loaderSource: "jar" });
        expect(found.targets).toContainEqual(expect.objectContaining({ type: "modloader", name: "forge" }));
        expect(candidate.targets).toHaveLength(1); // Keep upstream records unchanged.
        expect(requests[0]).toContain(`/versions/${mcVersion}/1`);
    });

    it.each([
        ["fabric", "fabric.mod.json", '{"id":"fixture","version":"1"}'],
        ["quilt", "quilt.mod.json", '{"quilt_loader":{"id":"fixture","version":"1"}}'],
        ["forge", "META-INF/mods.toml", 'modLoader="javafml"\n[[mods]]\nmodId="fixture"'],
        ["neoforge", "META-INF/mods.toml", '[[mods]]\nmodId="fixture"\n[[dependencies.fixture]]\nmodId="neoforge"'],
        ["neoforge", "META-INF/neoforge.mods.toml", 'modLoader="javafml"\n[[mods]]\nmodId="fixture"'],
    ])("recovers %s from %s", async (loader, name, content) => {
        const candidate = version({ mcVersion: "1.20.1", files: { [name]: content } });
        serve([[candidate]]);
        const [found] = await providerVersions("mod", projectId, { loader, mcVersion: "1.20.1" });
        expect(found.loaderSource).toBe("jar");
        expect(found.targets.some(value => value.type === "modloader" && value.name === loader)).toBe(true);
    });

    it("recognises every declared loader in a universal JAR", async () => {
        const candidate = version({ files: {
            "fabric.mod.json": '{"id":"fixture"}',
            "META-INF/mods.toml": '[[mods]]\nmodId="fixture"',
        } });
        serve([[candidate]]);
        for (const loader of ["forge", "fabric"]) {
            const [found] = await providerVersions("mod", projectId, { loader });
            expect(found.targets.filter(value => value.type === "modloader").map(value => value.name)).toEqual(["fabric", "forge"]);
        }
        expect(downloads()).toHaveLength(1);
    });

    it("keeps an unlabeled newest match ahead of an older labeled version", async () => {
        const newest = version();
        const older = version({ loader: "forge" });
        serve([[newest, older]]);
        expect((await providerVersions("mod", projectId, { loader: "forge", limit: 1 })).map(value => value.id)).toEqual([newest.id]);
    });

    it("applies limits after inspecting matches and follows later pages", async () => {
        const wrongLoader = version({ files: { "fabric.mod.json": '{"id":"fixture"}' } });
        const matching = version();
        serve([[wrongLoader], [matching]]);
        expect((await providerVersions("mod", projectId, { loader: "forge", limit: 1 })).map(value => value.id)).toEqual([matching.id]);
        expect(requests.filter(url => url.includes("/versions/"))).toHaveLength(2);
    });

    it("does not guess loaders from filenames or malformed metadata", async () => {
        const unknown = version({ files: { "fabric.mod.json": "{broken", "META-INF/mods.toml": "[broken" } });
        unknown.name = "fixture-forge-1.7.10.jar";
        serve([[unknown]]);
        expect(await providerVersions("mod", projectId, { loader: "forge" })).toEqual([]);
        expect(await providerVersions("mod", projectId, { loader: "fabric" })).toEqual([]);
    });

    it("ignores invalid metadata shapes while checking other loader declarations", async () => {
        const candidate = version({ files: {
            "fabric.mod.json": "null", "quilt.mod.json": "null", "META-INF/mods.toml": '[[mods]]\nmodId="fixture"',
        } });
        serve([[candidate]]);
        expect(await providerVersions("mod", projectId, { loader: "forge" })).toHaveLength(1);
        expect(await providerVersions("mod", projectId, { loader: "fabric" })).toEqual([]);
    });

    it("reuses inspection downloads for subsequent queries and ingestion", async () => {
        const candidate = version();
        serve([[candidate]]);
        await Promise.all([1, 2].map(() => providerVersions("mod", projectId, { loader: "forge" })));
        const path = await downloadModVersion(projectId, candidate);
        expect(await readFile(path)).toEqual(artifacts.get(candidate.url));
        expect(downloads()).toHaveLength(1);
        await downloadModVersion(projectId, candidate, true);
        expect(downloads()).toHaveLength(2);
    });

    it("re-downloads a damaged cached artifact before inspecting it", async () => {
        const candidate = version();
        serve([[candidate]]);
        const path = await downloadModVersion(projectId, candidate);
        await writeFile(path, "corrupt cache");
        expect(await providerVersions("mod", projectId, { loader: "forge" })).toHaveLength(1);
        expect(downloads()).toHaveLength(2);
    });

    it("re-inspects refreshed bytes when force is requested without an upstream checksum", async () => {
        const candidate = { ...version(), sha1: "" };
        serve([[candidate]]);
        expect(await providerVersions("mod", projectId, { loader: "forge" })).toHaveLength(1);
        const changed = version({ files: { "fabric.mod.json": '{"id":"fixture"}' } });
        artifacts.set(candidate.url, artifacts.get(changed.url)!);
        expect(await providerVersions("mod", projectId, { loader: "forge", force: true })).toEqual([]);
        expect(downloads()).toEqual([candidate.url, candidate.url]);
    });

    it("immediately prefers newly supplied upstream labels over cached inspection", async () => {
        const candidate = version();
        serve([[candidate]]);
        expect(await providerVersions("mod", projectId, { loader: "forge" })).toHaveLength(1);
        candidate.targets.push(target("modloader", "fabric"));
        expect(await providerVersions("mod", projectId, { loader: "forge" })).toEqual([]);
        expect(downloads()).toHaveLength(1);
    });

    it("leaves unfiltered and modpack requests free of artifact inspection", async () => {
        const candidate = version();
        serve([[candidate]]);
        expect(await providerVersions("mod", projectId)).toEqual([candidate]);
        expect(await providerVersions("modrinth", projectId, { loader: "forge" })).toEqual([candidate]);
        expect(requests[1]).toContain("/versions/forge/1");
        expect(downloads()).toEqual([]);
    });

    it("filters Minecraft versions before downloading unlabeled candidates", async () => {
        const wrongGame = version({ mcVersion: "1.12.2" });
        const matching = version();
        serve([[wrongGame, matching]]);
        expect(await providerVersions("mod", projectId, { mcVersion: "1.7.10", loader: "forge" })).toHaveLength(1);
        expect(downloads()).toEqual([matching.url]);
    });

    it("supports range-filtered update checks for both provider adapters", async () => {
        const wrongGame = version({ mcVersion: "1.21.1" });
        const matching = version();
        serve([[wrongGame, matching]]);
        expect(await getLatestFile(projectId, "[1.7.10,1.8)", "forge")).toMatchObject({ id: matching.id, loaderSource: "jar" });
        expect(await getLatestVersion(String(projectId), "[1.7.10,1.8)", "forge")).toMatchObject({ id: String(matching.id), loaders: ["forge"], loaderSource: "jar" });
        expect((await getProjectVersions(String(projectId), { mcVersion: "1.7.10", loader: "forge" }))[0].loaders).toEqual(["forge"]);
        expect(downloads()).toEqual([matching.url]);
    });

    it("uses the same fallback for loader-filtered project search", async () => {
        const candidate = version();
        serve([], url => url.includes("/search/")
            ? Response.json({ pages: 1, mods: [{ id: projectId, name: "Fixture" }] })
            : Response.json({ pages: 1, versions: [candidate] }));
        const [found] = await providerSearch("curseforge", "mod", "fixture", { mcVersion: "1.7.10", loader: "forge", limit: 1 });
        expect(found).toMatchObject({ id: projectId, loaderSource: "jar" });
        expect(found.targets).toContainEqual(expect.objectContaining({ name: "forge", type: "modloader" }));
        expect(requests[0]).toContain("/mods/search/1.7.10/1?term=fixture");
    });

    it("surfaces provider errors without trying artifacts or another metadata service", async () => {
        serve([], () => Response.json({ status: "error", message: "Provider unavailable" }));
        await expect(providerVersions("mod", projectId, { loader: "forge" })).rejects.toThrow("Provider unavailable");
        expect(requests).toHaveLength(1);
    });

    it("reports unreadable JARs instead of treating them as loader matches", async () => {
        const candidate = version({ body: Buffer.from("not a jar") });
        serve([[candidate]]);
        await expect(providerVersions("mod", projectId, { loader: "forge" })).rejects.toThrow("Unable to inspect loader");
    });

    it("rejects checksum mismatches and removes partial downloads", async () => {
        const candidate = version();
        artifacts.set(candidate.url, Buffer.from("wrong download"));
        serve([[candidate]]);
        await expect(providerVersions("mod", projectId, { loader: "forge" })).rejects.toThrow("SHA-1 mismatch");
        expect(await readdir(join(CACHE_ROOT, "mods", String(projectId)))).toEqual([]);
    });

    it("keeps a download failure distinct from no matching loader", async () => {
        const candidate = version();
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url === candidate.url
            ? new Response("Gone", { status: 404 }) : Response.json({ versions: [candidate] })));
        await expect(providerVersions("mod", projectId, { loader: "forge" })).rejects.toThrow("HTTP 404");
    });

    it("rejects artifact cache paths outside the project cache", async () => {
        const candidate = version();
        serve([[candidate]]);
        await expect(downloadModVersion("../escaped", candidate)).rejects.toThrow("Path traversal");
        expect(requests).toEqual([]);
    });
});
