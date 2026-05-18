/**
 * Background semantic embedding queue.
 *
 * A single-worker FIFO queue that embeds decompiled mod source files into
 * pgvector one mod at a time. This prevents overwhelming Ollama when multiple
 * mods finish decompiling simultaneously.
 *
 * Features:
 *  - Deduplication: adding the same dbId twice is a no-op
 *  - Retry loop: each item is retried (with backoff) until remaining === 0
 *  - Availability check: if Ollama goes down mid-queue, the worker pauses and
 *    retries the current item on the next drain cycle
 *  - Startup scan: call startupEmbedScan() on server start to re-queue any
 *    mods that were partially embedded before a restart
 */
import { isOllamaAvailable } from "./embeddings.js";
import { indexModSourceSemantic } from "./tools/mc-fts.js";
import { getDb } from "./db.js";

// ── Queue state (module-level singleton) ──────────────────────────────────────
const pending = new Set<number>(); // dbIds waiting to be embedded
let running = false;               // true while the worker loop is active
const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 10_000;    // 10 s between retries when Ollama is slow
const OLLAMA_WAIT_MS = 30_000;    // 30 s wait when Ollama is unreachable

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a mod to the embedding queue.
 * Safe to call multiple times — duplicates are ignored.
 * Returns immediately; embedding happens in the background.
 */
export function enqueueModEmbed(dbId: number): void {
    pending.add(dbId);
    void drainQueue();
}

/**
 * Scan the DB for mods that are decompiled but not fully embedded and enqueue
 * them. Call once at server startup so restarts don't leave things stuck.
 */
export async function startupEmbedScan(): Promise<void> {
    if (!await isOllamaAvailable()) return; // skip silently if Ollama is off

    // One fast query: find all mod_ids that still have unembedded source files
    const db = await getDb();
    const rows = await db.$queryRawUnsafe<Array<{ mod_id: number }>>(
        `SELECT DISTINCT mod_id FROM mod_source_files WHERE embedding IS NULL`,
    );
    for (const { mod_id } of rows) {
        pending.add(mod_id);
    }
    if (pending.size > 0) {
        console.error(`[embed-queue] startup scan: ${pending.size} mod(s) queued for embedding`);
        void drainQueue();
    }
}

// ── Worker ────────────────────────────────────────────────────────────────────

async function drainQueue(): Promise<void> {
    if (running) return; // already active
    running = true;

    try {
        while (pending.size > 0) {
            // Check Ollama before dequeuing — if it's down, hold all items
            if (!await isOllamaAvailable()) {
                console.error("[embed-queue] Ollama unavailable — pausing, will retry in 30 s");
                await delay(OLLAMA_WAIT_MS);
                continue; // re-check without dequeuing
            }

            const [dbId] = pending; // peek — remove only after success
            pending.delete(dbId);

            // Retry this item until fully embedded or max retries exceeded
            let attempts = 0;
            while (attempts < MAX_RETRIES) {
                try {
                    const result = await indexModSourceSemantic(dbId);
                    if (result.remaining === 0) break; // done
                    // Some files remain (Ollama timed out mid-batch) — retry
                    console.error(
                        `[embed-queue] mod #${dbId}: ${result.remaining} files remaining — retry ${attempts + 1}/${MAX_RETRIES}`,
                    );
                } catch (err) {
                    console.error(`[embed-queue] mod #${dbId} error:`, err);
                }
                attempts++;
                await delay(RETRY_DELAY_MS);

                // Re-check Ollama before next attempt
                if (!await isOllamaAvailable()) {
                    // Put it back and stop — will resume on next enqueue or startup
                    pending.add(dbId);
                    console.error("[embed-queue] Ollama went away — requeueing mod #" + dbId);
                    return;
                }
            }

            if (attempts >= MAX_RETRIES) {
                console.error(`[embed-queue] mod #${dbId} gave up after ${MAX_RETRIES} attempts`);
            }
        }
    } finally {
        running = false;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
