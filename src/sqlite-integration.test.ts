import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { getDb, disconnect } from "./db.js";
import { initializeSqliteDatabase } from "./sqlite-schema.js";
import { sqliteArrayMemberIds } from "./repositories/array-fields.js";
import { decodeStoredEmbedding } from "./tools/embed-registry.js";
import { ftsSearchDocs } from "./search-adapter.js";
import { upsertModSourceEmbedding, searchModSourceByVector, getEmbedSources } from "./repositories/embeddings.js";
import { exportModEmbeddings, importEmbeddingsBundle } from "./tools/embed-registry.js";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { downloadGraph } from "./tools/graphify.js";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

let root: string;
let path: string;
beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "modlens-sqlite-regression-"));
    path = join(root,"test.db");
    vi.stubEnv("DATABASE_URL",`file:${path.replaceAll("\\","/")}`);
});
afterAll(async () => {
    await disconnect();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (!resolve(root).startsWith(resolve(tmpdir())+sep)) throw new Error("Unexpected test directory");
    await rm(root,{recursive:true,force:true});
});
describe("SQLite application schema and public model shapes", () => {
    it("round-trips arrays, objects and included relations", async () => {
        const db = await getDb();
        const mod = await db.mod.create({data:{modId:"fixture",displayName:"Fixture",version:"1",mcVersion:"[1.21,1.22)",loader:"fabric",jarPath:join(root,"fixture.jar"),
            dependencies:[{id:"required",version:"*",required:true}], metadata:{sourceUrl:"https://example.org/source"},
            mixinTargets:["net/minecraft/Level"], classes:{create:{className:"Fixture",interfaces:["net/test/Interface"]}},
        },include:{classes:true}});
        expect(mod.dependencies).toEqual([{id:"required",version:"*",required:true}]);
        expect(mod.metadata).toEqual({sourceUrl:"https://example.org/source"});
        expect(mod.classes[0].interfaces).toEqual(["net/test/Interface"]);
        const parent = await db.modClass.findFirst({include:{mod:true}});
        expect(parent?.mod.mixinTargets).toEqual(["net/minecraft/Level"]);
        expect(await sqliteArrayMemberIds("mod_classes","interfaces","net/test/Interface")).toEqual([mod.classes[0].id]);
        expect(await sqliteArrayMemberIds("mod_classes","interfaces","net/test/Inter")).toEqual([]);
        const updated = await db.mod.update({where:{id:mod.id},data:{classes:{update:{where:{id:mod.classes[0].id},data:{interfaces:["net/test/Updated"]}}}},include:{classes:true}});
        expect(updated.classes[0].interfaces).toEqual(["net/test/Updated"]);
    });
    it("stores documentation tags and maintains FTS on insert, update and delete", async () => {
        const db = await getDb();
        const doc = await db.docEntry.create({data:{title:"Quasar",summary:"Star fixture",url:"https://example.org/doc",category:"minecraft",namespace:"vanilla",source:"test",tags:['quote"tag']}});
        expect(doc.tags).toEqual(['quote"tag']);
        expect(await sqliteArrayMemberIds("doc_entries","tags",'quote"tag')).toEqual([doc.id]);
        const lookup = (term:string) => db.$queryRawUnsafe<Array<{title:string}>>("SELECT title FROM fts_doc_entries WHERE fts_doc_entries MATCH $1",term);
        expect(await lookup("Quasar")).toHaveLength(1);
        await db.docEntry.update({where:{id:doc.id},data:{title:"Pulsar"}});
        expect(await lookup("Quasar")).toHaveLength(0);
        expect(await lookup("Pulsar")).toHaveLength(1);
        await db.docEntry.delete({where:{id:doc.id}});
        expect(await lookup("Pulsar")).toHaveLength(0);
    });
    it("searches qualified names and empty queries without FTS syntax errors", async () => {
        const db = await getDb();
        const doc = await db.docEntry.create({data:{title:"net.minecraft.world.level.Level",url:"https://example.org/level",category:"minecraft",namespace:"vanilla",source:"test"}});
        expect((await ftsSearchDocs("net.minecraft.world.level.Level")).map(row=>row.id)).toEqual([doc.id]);
        expect(await ftsSearchDocs("  ")).toEqual([]);
        expect(await ftsSearchDocs('"')).toEqual([]);
    });
    it("repairs missing pack and FTS tables without replacing existing mods", async () => {
        await disconnect();
        const raw = new Database(path);
        raw.exec("DROP TABLE pack_files; DROP TABLE pack_versions; DROP TABLE fts_mod_source;");
        raw.close();
        initializeSqliteDatabase(path);
        const db = await getDb();
        expect(await db.mod.count()).toBe(1);
        expect(await db.packVersion.count()).toBe(0);
        expect(await db.$queryRawUnsafe("SELECT count(*) AS n FROM fts_mod_source")).toHaveLength(1);
    });
    it("decodes SQLite float32 embeddings without a PostgreSQL cast", () => {
        const bytes = Buffer.alloc(8); bytes.writeFloatLE(0.25,0); bytes.writeFloatLE(-1.5,4);
        expect(decodeStoredEmbedding(bytes)).toEqual([0.25,-1.5]);
        expect(decodeStoredEmbedding("[0.25,-1.5]")).toEqual([0.25,-1.5]);
    });
    it("dispatches vectors to SQLite, scopes cosine search before limiting, and exports portable vectors", async () => {
        const db = await getDb();
        vi.stubEnv("OLLAMA_EMBED_DIM", "2");
        const other = await db.mod.create({data:{modId:"other",displayName:"Other",version:"1",mcVersion:"1.21.1",loader:"fabric",jarPath:join(root,"other.jar")}});
        const a = await db.modSourceFile.create({data:{modId:1,className:"fixture/Scoped",content:"class Scoped {}"}});
        const b = await db.modSourceFile.create({data:{modId:other.id,className:"fixture/Other",content:"class Other {}"}});
        await upsertModSourceEmbedding(a.id, [0.8,0.6], "registry");
        await upsertModSourceEmbedding(b.id, [1,0]);
        const found = await searchModSourceByVector([1,0],1,1,"registry");
        expect(found).toHaveLength(1);
        expect(found[0].id).toBe(a.id);
        expect(found[0].similarity).toBeCloseTo(0.8);
        expect((await getEmbedSources("mod_source_files",[a.id])).get(a.id)?.source).toBe("registry");
        const exported = await exportModEmbeddings(1,root);
        const bundle = JSON.parse(gunzipSync(await readFile(exported.path)).toString());
        expect(bundle.entries).toHaveLength(1);
        expect(bundle.entries[0].embedding[0]).toBeCloseTo(0.8);
        expect(bundle.dimensions).toBe(2);
        expect(await importEmbeddingsBundle(exported.path,{force:true})).toMatchObject({status:"ok",imported:1});
    });
    it("downloads a wrapped gzip graph bundle and verifies the compressed checksum", async () => {
        const graph = {nodes:[{id:"fixture/Scoped"}],edges:[]};
        const bytes = gzipSync(JSON.stringify({version:1,graph}));
        const graphUrl = "https://example.org/graph.json.gz";
        const entry = {modId:"fixture",version:"1",graphUrl,sha256:createHash("sha256").update(bytes).digest("hex"),nodeCount:1,edgeCount:0};
        vi.stubGlobal("fetch", async (url: string) => url === graphUrl
            ? new Response(bytes) : Response.json({version:1,graphs:[entry]}));
        const db = await getDb();
        // Force all graph output into this test's disposable directory.
        await db.mod.update({where:{id:1},data:{sourcePath:root}});
        expect(await downloadGraph(1)).toMatchObject({status:"downloaded",nodeCount:1});
        expect(JSON.parse(await readFile(join(root,"graphify-out","graph.json"),"utf8"))).toEqual(graph);
    });
});
