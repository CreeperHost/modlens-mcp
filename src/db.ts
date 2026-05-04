import { PrismaClient } from "@prisma/client";

let _client: PrismaClient | null = null;

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
