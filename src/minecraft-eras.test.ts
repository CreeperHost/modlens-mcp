import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";

const directories: string[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it("uses one version catalog for source access and platform listing, including mapped alpha/beta versions", async () => {
    const versions = [
        { id: "a1.2.6", type: "old_alpha", releaseTime: "2010-12-03" },
        { id: "b1.7.3", type: "old_beta", releaseTime: "2011-07-08" },
        { id: "1.2.5", type: "release", releaseTime: "2012-04-04" },
        { id: "1.5.2", type: "release", releaseTime: "2013-05-02" },
        { id: "1.6.4", type: "release", releaseTime: "2013-09-19" },
        { id: "1.7.10", type: "release", releaseTime: "2014-06-26" },
        { id: "1.12.2", type: "release", releaseTime: "2017-09-18" },
        { id: "1.13.2", type: "release", releaseTime: "2018-10-22" },
        { id: "1.21.1", type: "release", releaseTime: "2024-08-08" },
        { id: "24w14a", type: "snapshot", releaseTime: "2024-04-03" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ versions })));
    const { fetchMcVersionList } = await import("./minecraft.js");
    const { listMcVersions } = await import("./platform.js");
    expect(await fetchMcVersionList(true)).toEqual(versions);
    expect(await listMcVersions("all")).toEqual(versions);
    expect(await listMcVersions("release")).toEqual(versions.filter(row => row.type === "release"));
    expect(await listMcVersions("snapshot")).toEqual([versions.at(-1)]);
    expect(fetch).toHaveBeenCalledTimes(1);
});

function archive(files: Record<string, string>) {
    const zip = new AdmZip();
    for (const [name, text] of Object.entries(files)) zip.addFile(name, Buffer.from(text));
    return new Uint8Array(zip.toBuffer());
}

describe("legacy mapping artifact formats", () => {
    it.each([
        ["1.6.4", "srg", false], ["1.7.10", "srg", true], ["1.8.9", "srg", true],
        ["1.12.2", "srg", true], ["1.13.2", "tsrg", true], ["1.14.4", "tsrg", true],
    ] as const)("combines %s %s mappings and remaps object descriptors", async (version, format, hasMcpNames) => {
        const directory = await mkdtemp(join(tmpdir(), "modlens-mapping-era-"));
        directories.push(directory);
        vi.stubEnv("MODLENS_CACHE_ROOT", directory);
        const urls: string[] = [];
        const srg = "CL:  a net/minecraft/world/World\r\nCL: b net/minecraft/entity/Entity\r\nFD: a/c net/minecraft/world/World/field_1_a\r\nMD: a/d (Lb;)Lb; net/minecraft/world/World/func_1_a (Lnet/minecraft/entity/Entity;)Lnet/minecraft/entity/Entity;\r\n";
        const tsrg = "a net/minecraft/world/World\r\n\tc field_1_a\r\n\td (Lb;)Lb; func_1_a\r\nb net/minecraft/entity/Entity\r\n";
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            urls.push(url);
            if (url.includes("/mcp_stable/")) return new Response(archive({
                "methods.csv": 'searge,name,side,desc\r\nfunc_1_a,findEntity,2,"Find an entity, if present"\r\n',
                "fields.csv": "searge,name,side,desc\r\nfield_1_a,entities,2,Entities\r\n",
            }));
            if (url.includes("/mcp_config/")) return new Response(archive({ "config/joined.tsrg": tsrg }));
            return format === "srg" ? new Response(archive({ "joined.srg": srg })) : new Response(null, { status: 404 });
        }));
        const { generateCombinedSrg } = await import("./mappings.js");
        const path = await generateCombinedSrg(version);
        expect(path).not.toBeNull();
        const combined = await readFile(path!, "utf8");
        expect(combined).toContain(`FD: a/c net/minecraft/world/World/${hasMcpNames ? "entities" : "field_1_a"}`);
        expect(combined).toContain(`MD: a/d (Lb;)Lb; net/minecraft/world/World/${hasMcpNames ? "findEntity" : "func_1_a"} (Lnet/minecraft/entity/Entity;)Lnet/minecraft/entity/Entity;`);
        expect(urls.every(url => url.startsWith("https://maven.creeperhost.net/"))).toBe(true);
        const count = urls.length;
        expect(await generateCombinedSrg(version)).toBe(path);
        expect(urls).toHaveLength(count);
    });
});
