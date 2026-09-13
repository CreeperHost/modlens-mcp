import { afterEach, expect, it, vi } from "vitest";
import { getProject as getMrProject, getProjectVersions, getLatestVersion, searchProjects } from "./modrinth.js";
import { searchMods as searchCfMods } from "./curseforge.js";
import { getOfficialFtbPack } from "./feed-the-beast.js";
import { providerSearch, resolveModVersionUrl, type ModVersion } from "./modpacks-ch.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("uses modpacks.ch for both providers and FTB, without requiring a CurseForge key",async()=>{
    const urls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:string)=>{
        urls.push(input);
        if(input.includes("search"))return Response.json({status:"success",mods:[{id:12,name:"Fixture",synopsis:"Test",installs:1}]});
        return Response.json({status:"success",id:"abc",name:"Fixture",versions:[],links:[]});
    }));
    expect((await searchProjects("name & test")).hits).toHaveLength(1);
    expect(await searchCfMods("name & test")).toHaveLength(1);
    expect((await getMrProject("abc"))?.title).toBe("Fixture");
    await getOfficialFtbPack(123);
    expect(urls.every(u=>u.startsWith("https://api.modpacks.ch/public/"))).toBe(true);
    expect(urls[0]).toContain("term=name%20%26%20test");
    expect(urls.some(u=>u.endsWith("/ftb/123"))).toBe(true);
});
it("follows complete paginated version history and preserves provider version IDs",async()=>{
    const urls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:string)=>{
        urls.push(input);
        return Response.json({status:"success",pages:2,versions:[{id:input.endsWith("/1") ? "a" : "b",name:"file.jar",version:"1",updated:1,targets:[{type:"game",version:"1.21.1"},{type:"modloader",name:"fabric"}]}]});
    }));
    expect((await getProjectVersions("project",{mcVersion:"1.21.1",loader:"fabric"})).map(v=>v.id)).toEqual(["a","b"]);
    expect(urls).toEqual(["https://api.modpacks.ch/public/mod/project/versions/1.21.1/1","https://api.modpacks.ch/public/mod/project/versions/1.21.1/2"]);
});
it("does not hide a semantic API error or silently contact another service",async()=>{
    const fetch=vi.fn(async()=>Response.json({status:"error",message:"Provider unavailable"}));
    vi.stubGlobal("fetch",fetch);
    await expect(getMrProject("abc")).rejects.toThrow("Provider unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
});
it("pages default browse searches without applying the invalid all filter",async()=>{
    const urls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:string)=>{
        urls.push(input);
        return Response.json({status:"success",pages:2,mods:[{id:urls.length,name:"Fixture"}]});
    }));
    expect(await providerSearch("modrinth","mod","sodium",{limit:2})).toHaveLength(2);
    expect(urls).toEqual(["https://api.modpacks.ch/public/modrinth/mods/search/1?term=sodium","https://api.modpacks.ch/public/modrinth/mods/search/2?term=sodium"]);
});
it("uses supplied mirrors and never constructs a CurseForge URL from a Modrinth ID",()=>{
    const version = {id:"abcd1234",name:"fixture.jar",url:"",mirrors:["https://cdn.modrinth.com/fixture.jar"]} as ModVersion;
    expect(resolveModVersionUrl(version)).toBe(version.mirrors[0]);
    expect(resolveModVersionUrl({...version,mirrors:[]})).toBeNull();
});
it("preserves the loader while resolving a Minecraft version declaration for updates",async()=>{
    const urls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:string)=>{
        urls.push(input);
        return Response.json({versions:[{id:"fabric-version",name:"fixture.jar",updated:1,targets:[{type:"game",version:"1.21.1"},{type:"modloader",name:"fabric"}]}],pages:1});
    }));
    expect((await getLatestVersion("fixture", ">=1.21 <1.22", "fabric"))?.id).toBe("fabric-version");
    expect(urls).toEqual(["https://api.modpacks.ch/public/mod/fixture/versions/all/1"]);
});

it("only attaches a configured download key to the provider's own domains", async () => {
    vi.resetModules();
    vi.stubEnv("CURSEFORGE_API_KEY", "fixture-key");
    const { withCurseForgeApiKey } = await import("./modpacks-ch.js");
    expect(new URL(withCurseForgeApiKey("https://edge.forgecdn.net/files/fixture.jar")).searchParams.get("apiKey")).toBe("fixture-key");
    for (const url of ["https://notforgecdn.net/fixture.jar", "https://curseforge.com.example.invalid/fixture.jar", "https://cdn.modrinth.com/fixture.jar"]) {
        expect(withCurseForgeApiKey(url)).toBe(url);
    }
});
