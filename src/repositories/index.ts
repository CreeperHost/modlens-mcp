// src/repositories/index.ts
/**
 * Factory for the embeddings repository.
 * Returns the pgvector implementation for postgres/pglite,
 * and (in P2) the sqlite-vec implementation for sqlite.
 */
import { detectBackend } from "../db-backend.js";

export async function getEmbeddingsRepo() {
    const backend = detectBackend();
    if (backend === "sqlite") {
        // Wired in P2
        throw new Error("SQLite embeddings not yet implemented. See P2.");
    }
    return import("./embeddings.js");
}
