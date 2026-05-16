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
        // Wired in P2
        throw new Error(
            `SQLite backend not yet supported. Run \`npm run setup\` to switch backends.`,
        );
    }

    if (backend === "pglite") {
        // Wired in P3
        throw new Error(
            `PGlite backend not yet supported. Run \`npm run setup\` to switch backends.`,
        );
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
