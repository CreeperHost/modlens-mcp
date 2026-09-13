import { readFile, stat } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { validateEmbeddingBundle, validateGraphBundle, validateEmbedRegistryIndex, validateGraphRegistryIndex } from "./security.js";

type Kind = "graph" | "embed";
type Json = Record<string, any>;
export interface RegistrySubmission { bundlePath: string; contributor?: string; note?: string }

export async function prepareRegistryBundle(kind: Kind, path: string) {
    if (!path) throw new Error("Provide bundlePath from graph_export or embed_export");
    if ((await stat(path)).size > 95_000_000) throw new Error("Registry submissions must be smaller than 95 MB");
    const input = await readFile(path);
    const compressed = input[0] === 0x1f && input[1] === 0x8b;
    const raw = compressed ? gunzipSync(input, {maxOutputLength:200_000_000}) : input;
    const bundle = JSON.parse(raw.toString("utf8")) as Json;
    const check = kind === "graph" ? validateGraphBundle(bundle.graph) : validateEmbeddingBundle(bundle);
    if (!check.valid) throw new Error(`Invalid ${kind} bundle: ${check.reason}`);
    const targetType = bundle.targetType ?? "mod";
    const targetId = bundle.targetId ?? bundle.modId;
    const targetVersion = bundle.targetVersion ?? bundle.modVersion;
    if (bundle.version !== 1 || !["mod","vanilla","modloader"].includes(targetType)
        || typeof targetId !== "string" || !targetId || typeof targetVersion !== "string" || !targetVersion) {
        throw new Error("Bundle must specify version 1 and a target type, identifier and version");
    }
    const data = compressed ? input : gzipSync(raw);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const file = `bundles/${kind}/${sha256}.json.gz`;
    const common = {targetType,targetId,targetVersion,loader:bundle.loader ?? "",mcVersion:bundle.mcVersion ?? "",sha256};
    const entry: Json = kind === "graph" ? {...common,modId:targetId,version:targetVersion,graphUrl:file,
        nodeCount:bundle.graph.nodes.length,edgeCount:bundle.graph.edges.length,
        enriched:bundle.graph.nodes.some((n: Json)=>n.community != null),updatedAt:new Date().toISOString()}
        : {...common,url:file,model:bundle.model,dimensions:bundle.dimensions,entryCount:bundle.entries.length,sizeBytes:data.length};
    return {data,file,entry};
}

/** Atomically propose the bundle and index together on a branch, then open a draft PR. */
export async function submitRegistryBundle(kind: Kind, registryUrl: string, submission: RegistrySubmission) {
    const prepared = await prepareRegistryBundle(kind, submission.bundlePath);
    const token = process.env.MODLENS_REGISTRY_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!token) throw new Error("Set MODLENS_REGISTRY_TOKEN or GITHUB_TOKEN with repository Contents and Pull requests write permissions");
    const prefix = `MODLENS_${kind.toUpperCase()}_REGISTRY`;
    const url = new URL(registryUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const repo = process.env[`${prefix}_REPO`] ?? (url.hostname === "raw.githubusercontent.com" ? parts.slice(0,2).join("/") : "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Set ${prefix}_REPO to the GitHub owner/repository for this registry`);
    const base = process.env[`${prefix}_BRANCH`] ?? (url.hostname === "raw.githubusercontent.com" ? parts[2] : undefined) ?? "main";
    const indexPath = process.env[`${prefix}_INDEX_PATH`] ?? (url.hostname === "raw.githubusercontent.com" ? parts.slice(3).join("/") : "index.json");
    if (!indexPath || indexPath.split("/").some(p=>p === ".." || p === "." || !p)) throw new Error("Invalid registry index path");
    const request = async (path: string, body?: unknown, allowMissing = false, accept = "application/vnd.github+json"): Promise<any> => {
        const response = await fetch(`https://api.github.com${path}`, {
            method:body === undefined ? "GET" : "POST", redirect:"error", signal:AbortSignal.timeout(30_000),
            headers:{Authorization:`Bearer ${token}`,Accept:accept,"Content-Type":"application/json","User-Agent":"modlens-mcp", "X-GitHub-Api-Version":"2026-03-10"},
            ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        });
        if (allowMissing && response.status === 404) return null;
        // Do not include responses or headers: proxies may echo authorization material.
        if (!response.ok) throw new Error(`GitHub registry request failed (${response.status}) for ${path.split("?")[0]}`);
        return response.json();
    };
    const upstream = await request(`/repos/${repo}`);
    const ref = await request(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    const commit = await request(`/repos/${repo}/git/commits/${ref.object.sha}`);
    const key = kind === "graph" ? "graphs" : "bundles";
    const index: Json = await request(`/repos/${repo}/contents/${indexPath.split("/").map(encodeURIComponent).join("/")}?ref=${ref.object.sha}`, undefined, true, "application/vnd.github.raw+json")
        ?? (kind === "graph" ? {version:1,graphs:[]} : {version:1,models:[],bundles:[]});
    const check = kind === "graph" ? validateGraphRegistryIndex(index) : validateEmbedRegistryIndex(index);
    if (!check.valid) throw new Error(`Invalid registry index: ${check.reason}`);
    if (index[key].some((e: Json)=>e.sha256 === prepared.entry.sha256)) {
        return {status:"already_published",repository:repo,sha256:prepared.entry.sha256};
    }
    const identity = (e: Json) => JSON.stringify([e.targetType ?? "mod",e.targetId ?? e.modId,e.targetVersion ?? e.modVersion ?? e.version,e.loader ?? "",e.mcVersion ?? "",e.model ?? "",e.dimensions ?? ""]);
    index[key] = [...index[key].filter((e: Json)=>identity(e) !== identity(prepared.entry)), prepared.entry];
    if (kind === "embed") index.models = [...new Set([...(index.models ?? []), prepared.entry.model])];
    let destination = repo;
    if (!upstream.permissions?.push) {
        const user = await request("/user");
        destination = `${user.login}/${repo.split("/")[1]}`;
        let fork = await request(`/repos/${destination}`, undefined, true);
        if (!fork) {
            fork = await request(`/repos/${repo}/forks`, {default_branch_only:false});
            // GitHub can return before the new fork's Git objects are ready.
            let ready = false;
            for (let attempt = 0; attempt < 5; attempt++) {
                if (await request(`/repos/${destination}/git/commits/${ref.object.sha}`, undefined, true)) { ready = true; break; }
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
            if (!ready) throw new Error("Registry fork is still being created. Retry the same bundle shortly.");
        }
        if (fork.parent?.full_name?.toLowerCase() !== repo.toLowerCase()) throw new Error(`Repository ${destination} is not a fork of ${repo}`);
    }
    const branch = `wip/modlens-${kind}-${prepared.entry.sha256.slice(0,20)}`;
    const head = `${destination.split("/")[0]}:${branch}`;
    const existing = await request(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`);
    if (existing[0]) return {status:"submitted",url:existing[0].html_url,repository:repo,branch};
    const branchRef = await request(`/repos/${destination}/git/ref/heads/${encodeURIComponent(branch)}`, undefined, true);
    if (!branchRef) {
        const blob = await request(`/repos/${destination}/git/blobs`, {content:prepared.data.toString("base64"),encoding:"base64"});
        const parentDir = indexPath.includes("/") ? indexPath.slice(0,indexPath.lastIndexOf("/")+1) : "";
        const tree = await request(`/repos/${destination}/git/trees`, {base_tree:commit.tree.sha,tree:[
            {path:parentDir+prepared.file,mode:"100644",type:"blob",sha:blob.sha},
            {path:indexPath,mode:"100644",type:"blob",content:JSON.stringify(index,null,2)+"\n"},
        ]});
        const next = await request(`/repos/${destination}/git/commits`, {
            message:`Add ${kind} bundle for ${prepared.entry.targetId} ${prepared.entry.targetVersion}`,
            tree:tree.sha,parents:[ref.object.sha],
        });
        await request(`/repos/${destination}/git/refs`, {ref:`refs/heads/${branch}`,sha:next.sha});
    }
    const pr = await request(`/repos/${repo}/pulls`, {
        title:`Add ${kind} bundle for ${prepared.entry.targetId} ${prepared.entry.targetVersion}`,head,base,draft:true,
        body:[`Add a validated ${kind} bundle and its registry entry.`,
            `Target: ${prepared.entry.targetType} ${prepared.entry.targetId} ${prepared.entry.targetVersion}`,
            `SHA-256: ${prepared.entry.sha256}`,submission.contributor ? `Contributor: ${submission.contributor}` : "",submission.note ?? ""].filter(Boolean).join("\n\n"),
    });
    return {status:"submitted",url:pr.html_url,repository:repo,branch,sha256:prepared.entry.sha256};
}
