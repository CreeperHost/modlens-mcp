// src/db-backend.ts
/**
 * Backend detection from DATABASE_URL shape.
 * This is the single runtime signal for which DB driver to use.
 */

export type Backend = "postgres" | "pglite" | "sqlite";

export function detectBackend(): Backend {
    const url = process.env.DATABASE_URL ?? "";
    if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "postgres";
    if (url.startsWith("pglite://") || url.startsWith("pglite:")) return "pglite";
    // SQLite is the default: explicit `file:`/`.db` URLs, and also the no-URL
    // case (zero-config embedded backend the launcher bootstraps on first run).
    return "sqlite";
}

/**
 * Prisma case-insensitive `contains`/`equals` modifier, backend-aware.
 *
 * Postgres/PGlite support `mode: "insensitive"` (ILIKE). The SQLite Prisma
 * connector rejects the `mode` argument entirely (`Unknown argument 'mode'`),
 * but SQLite's `LIKE` is already case-insensitive for ASCII — so we omit it.
 *
 * Spread into a string filter:
 *   { title: { contains: q, ...caseInsensitive() } }
 */
export function caseInsensitive(): { mode?: "insensitive" } {
    return detectBackend() === "sqlite" ? {} : { mode: "insensitive" };
}

/**
 * Serialize an array to a JSON string for SQLite String columns.
 * On postgres/pglite, returns the original value unchanged.
 */
export function serializeArray<T>(value: T[]): T[] | string {
    if (detectBackend() === "sqlite") return JSON.stringify(value);
    return value;
}

/**
 * Deserialize a SQLite JSON string column back to an array.
 * On postgres/pglite, returns the original value unchanged.
 */
export function deserializeArray<T>(value: unknown): T[] {
    if (typeof value === "string") {
        try { return JSON.parse(value) as T[]; } catch { return []; }
    }
    return (value as T[]) ?? [];
}
