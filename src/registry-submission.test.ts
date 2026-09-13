import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { submitRegistryBundle, prepareRegistryBundle } from "./registry-submission.js";
let root:string, path:string;
beforeEach(async()=>{
    root=await mkdtemp(join(tmpdir(),"modlens-registry-test-"));path=join(root,"graph.json.gz");
    await writeFile(path,gzipSync(JSON.stringify({version:1,targetType:"mod",targetId:"fixture",targetVersion:"1.0",loader:"fabric",mcVersion:"1.21.1",graph:{nodes:[{id:"A"},{id:"B"}],edges:[{source:"A",target:"B",relation:"extends"}]}})));
    vi.stubEnv("MODLENS_REGISTRY_TOKEN","test-token-only");
});
afterEach(async()=>{
    vi.unstubAllGlobals();vi.unstubAllEnvs();
    if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error("Unexpected fixture directory");
    await rm(root,{recursive:true,force:true});
});
it.each(["graph", "embed"] as const)("proposes the original %s bundle and index atomically in a draft PR",async(kind)=>{
    if (kind === "embed") await writeFile(path,gzipSync(JSON.stringify({version:1,model:"fixture",dimensions:2,targetType:"mod",targetId:"fixture",targetVersion:"1.0",entries:[{className:"fixture/Example",embedding:[1,0]}]})));
    const calls:Array<{path:string;body:any}>=[];
    vi.stubGlobal("fetch",vi.fn(async(url:string,opts:RequestInit)=>{
        const route=new URL(url).pathname;
        const body=opts.body ? JSON.parse(String(opts.body)) : undefined;
        calls.push({path:route,body});
        if(!opts.body){
            if(route.endsWith("/git/ref/heads/main"))return Response.json({object:{sha:"base"}});
            if(route.includes("/git/ref/heads/"))return new Response("",{status:404});
            if(route.endsWith("/git/commits/base"))return Response.json({tree:{sha:"base-tree"}});
            if(route.endsWith("/contents/index.json"))return Response.json({version:1,graphs:[],bundles:[],models:[]});
            if(route.endsWith("/pulls"))return Response.json([]);
            return Response.json({permissions:{push:true}});
        }
        return Response.json(route.endsWith("/pulls") ? {html_url:"https://github.com/test/graphs/pull/1"} : {sha:route.split("/").at(-1)});
    }));
    const result=await submitRegistryBundle(kind,"https://raw.githubusercontent.com/test/graphs/main/index.json",{bundlePath:path,note:"Fixture submission"});
    expect(result.status).toBe("submitted");
    const tree=calls.find(c=>c.path.endsWith("/git/trees"))!.body;
    expect(tree.base_tree).toBe("base-tree");
    expect(tree.tree).toHaveLength(2);
    const index=JSON.parse(tree.tree.find((e:any)=>e.path==="index.json").content);
    if (kind === "graph") expect(index.graphs[0]).toMatchObject({nodeCount:2,edgeCount:1,targetId:"fixture"});
    else expect(index.bundles[0]).toMatchObject({entryCount:1,dimensions:2,model:"fixture",targetId:"fixture"});
    const blob=calls.find(c=>c.path.endsWith("/git/blobs"))!.body;
    expect(Buffer.from(blob.content,"base64")).toEqual((await prepareRegistryBundle(kind,path)).data);
    const pr=calls.find(c=>c.path.endsWith("/pulls") && c.body)!.body;
    expect(pr).toMatchObject({draft:true,base:"main"});
    expect(pr.body).not.toContain(root);
    expect(calls.some(c=>c.path.includes("/merge"))).toBe(false);
});
it("rejects an invalid bundle before contacting a registry",async()=>{
    await writeFile(path,gzipSync('{"version":1,"graph":{}}'));
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(submitRegistryBundle("graph","https://raw.githubusercontent.com/test/graphs/main/index.json",{bundlePath:path})).rejects.toThrow("Invalid graph bundle");
    expect(fetch).not.toHaveBeenCalled();
});
it("does not expose a token or error response from a failed request",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("test-token-only",{status:403})));
    await expect(submitRegistryBundle("graph","https://raw.githubusercontent.com/test/graphs/main/index.json",{bundlePath:path})).rejects.toThrow("GitHub registry request failed (403)");
});
