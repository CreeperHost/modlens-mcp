/**
 * Ollama embeddings client.
 * All semantic-search features are optional — if Ollama is not running,
 * isOllamaAvailable() returns false and callers fall back to keyword search.
 *
 * Environment variables:
 *   OLLAMA_URL          Base URL (default: http://localhost:11434)
 *   OLLAMA_EMBED_MODEL  Model to use  (default: nomic-embed-text)
 */

const OLLAMA_URL  = () => process.env.OLLAMA_URL        ?? "http://localhost:11434";
const EMBED_MODEL = () => process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

/** Generate an embedding vector for a text string. Throws on Ollama error. */
export async function embed(text: string): Promise<number[]> {
    const res = await fetch(`${OLLAMA_URL()}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL(), prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
    const body = await res.json() as { embedding: number[] };
    return body.embedding;
}

/**
 * Generate embedding vectors for multiple texts in a single Ollama request.
 * Uses POST /api/embed (the modern batch endpoint).
 * Returns embeddings in the same order as the input array.
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${OLLAMA_URL()}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL(), input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama batch embed failed: ${res.status}`);
    const body = await res.json() as { embeddings: number[][] };
    return body.embeddings;
}

/** Returns false if Ollama is not reachable. Use to gate optional semantic features. */
export async function isOllamaAvailable(): Promise<boolean> {
    try {
        const res = await fetch(`${OLLAMA_URL()}/api/tags`, {
            signal: AbortSignal.timeout(2000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Split text into overlapping chunks for embedding long documents.
 * @param text      Full text to split
 * @param maxChars  Max characters per chunk (default 1500 ≈ 375 tokens)
 * @param overlap   Character overlap between consecutive chunks (default 200)
 */
export function chunkText(text: string, maxChars = 1500, overlap = 200): string[] {
    if (text.length <= maxChars) return [text];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        chunks.push(text.slice(start, start + maxChars));
        start += maxChars - overlap;
    }
    return chunks;
}
