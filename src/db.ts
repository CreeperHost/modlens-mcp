import { PrismaClient } from "@prisma/client";
import { detectBackend } from "./db-backend.js";

let _client: PrismaClient | null = null;

/**
 * Returns the shared Prisma client, initializing it on first call.
 * Backend is detected from DATABASE_URL shape (see db-backend.ts).
 * PGlite and SQLite branches are wired in P3 and P2 respectively.
 */
export async function getDb(): Promise<PrismaClient> {
    if (_client) return _client;
    const backend = detectBackend();

    if (backend === "sqlite") {
        const url = process.env.DATABASE_URL ?? "";
        const { PrismaBetterSQLite3 } = await import("@prisma/adapter-better-sqlite3");
        const adapter = new PrismaBetterSQLite3({ url });
        const { PrismaClient: SQLiteClient } = await import("./generated/sqlite/client.js");
        _client = new SQLiteClient({ adapter }) as unknown as PrismaClient;
        return _client;
    }

    if (backend === "pglite") {
        const { PGlite } = await import("@electric-sql/pglite");
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — optional peer dep, present only at runtime on supported platforms
        const { PrismaPGlite } = await import("@prisma/adapter-pglite");
        // pglite:///absolute/path → /absolute/path
        // pglite://relative/path  → relative/path
        const dataDir = (process.env.DATABASE_URL ?? "").replace(/^pglite:\/\//, "");
        if (!dataDir) {
            throw new Error(
                "DATABASE_URL for PGlite must be pglite:///path/to/data — data directory path is empty.",
            );
        }
        const pg = await PGlite.create(dataDir);
        const adapter = new PrismaPGlite(pg);
        _client = new PrismaClient({ adapter });
        return _client;
    }

    _client = new PrismaClient({
        log: process.env.DEBUG ? ["query", "error"] : ["error"],
    });
    return _client;
}

/** @deprecated Use `await getDb()` instead. Kept for incremental migration. */
export function db(): PrismaClient {
    if (!_client) {
        _client = new PrismaClient({
            log: process.env.DEBUG ? ["query", "error"] : ["error"],
        });
    }
    return _client;
}

export async function disconnect(): Promise<void> {
    await _client?.$disconnect();
    _client = null;
}
