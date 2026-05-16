// src/db-backend.ts
/**
 * Backend detection from DATABASE_URL shape.
 * This is the single runtime signal for which DB driver to use.
 */

export type Backend = "postgres" | "pglite" | "sqlite";

export function detectBackend(): Backend {
    const url = process.env.DATABASE_URL ?? "";
    if (url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
    if (url.startsWith("pglite://") || url.startsWith("pglite:")) return "pglite";
    return "postgres";
}
