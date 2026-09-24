import { mcPaths } from "../minecraft.js";
import { hasSrgMappings } from "../mappings.js";
import { validateVersion } from "../validate.js";
import { isDecompileDone } from "../java-tools.js";
import { indexMcVersion, isMcVersionIndexed } from "./mc-fts.js";
import { decompileMcVersion, ensureMcSourceNames, hasPendingMinecraftClassPreparation } from "./vanilla.js";

type VersionJob = { version: string; state: "queued" | "running" | "failed"; retryAfter?: number };
const jobs = new Map<string, VersionJob>();
const queue: VersionJob[] = [];
const completed = new Set<string>();
let running = false;

function pump(): void {
    if (running || !queue.length) return;
    const job = queue.shift()!;
    running = true;
    job.state = "running";
    void (async () => {
        try {
            if (!await isMcVersionIndexed(job.version)) {
                // Let requested classes finish first; later class jobs use a separate cache.
                for (let i = 0; i < 120 && hasPendingMinecraftClassPreparation(job.version); i++) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                await decompileMcVersion(job.version);
                let done = false;
                for (let i = 0; i < 1800; i++) {
                    const status = await isDecompileDone(mcPaths.decompiled(job.version));
                    if (status === "done") { done = true; break; }
                    if (status === "error") throw new Error(`Minecraft ${job.version} decompilation failed`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                if (!done) throw new Error(`Minecraft ${job.version} decompilation timed out`);
                if (hasSrgMappings(job.version)) await ensureMcSourceNames(job.version);
                const indexed = await indexMcVersion(job.version);
                if (indexed.status === "partial" || indexed.skipped) throw new Error(`Minecraft ${job.version} source indexing incomplete`);
            }
            completed.add(job.version);
            jobs.delete(job.version);
        } catch (error) {
            job.state = "failed";
            job.retryAfter = Date.now() + 60_000;
            console.error("[modlens] Minecraft version indexing failed", job.version, error);
        } finally {
            running = false;
            pump();
        }
    })();
}

/** Schedule one private full-version build after an authorized hosted Minecraft request. */
export function scheduleHostedMinecraftVersionIndex(version: unknown): void {
    if (typeof version !== "string") return;
    try { validateVersion(version); } catch { return; }
    if (completed.has(version)) return;
    let job = jobs.get(version);
    if (job?.state === "failed" && (job.retryAfter ?? 0) <= Date.now()) {
        jobs.delete(version);
        job = undefined;
    }
    if (job || queue.length >= 16) return;
    job = { version, state: "queued" };
    jobs.set(version, job);
    queue.push(job);
    pump();
}

export async function hostedMinecraftVersionIndexStatus(version: string) {
    validateVersion(version);
    const indexed = await isMcVersionIndexed(version);
    const job = jobs.get(version);
    const decompile = await isDecompileDone(mcPaths.decompiled(version));
    const status = indexed ? "ready" : job?.state === "failed" ? "failed"
        : job?.state === "queued" ? "queued" : job?.state === "running" ? "preparing"
        : decompile === "done" ? "needs_index" : decompile === "running" ? "decompiling" : "not_started";
    return { version, complete: indexed, status };
}
