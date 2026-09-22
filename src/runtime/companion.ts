import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RuntimeHub } from "./hub.js";
import { executeRuntime, runtimeRequest } from "./requests.js";

export const companionDescriptor = z.object({
    protocol: z.literal(1),
    pid: z.number().int().positive(),
    endpoint: z
        .string()
        .url()
        .refine((value) => {
            const url = new URL(value);
            return (
                url.protocol === "http:" &&
                url.hostname === "127.0.0.1" &&
                !!url.port &&
                url.pathname === "/runtime" &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash
            );
        }, "Companion must use loopback HTTP"),
    token: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CompanionDescriptor = z.infer<typeof companionDescriptor>;
export const descriptorPath = (root: string) => join(root, "companion.json");

/** Local CLI transport, not another MCP connection or an Internet control API. */
export async function startCompanion(root: string, agentJar?: string) {
    const hub = new RuntimeHub(root, agentJar);
    // Uses the same ownership lock as local stdio: never steal an active bridge.
    await hub.startLocalCompanion();
    const token = randomBytes(32).toString("hex");
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            try {
                const saved = JSON.parse(await readFile(descriptorPath(root), "utf8"));
                if (saved.token === token) await unlink(descriptorPath(root));
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT")
                    console.error("[runtime] Descriptor cleanup:", String(e));
            }
            await hub.close();
        })());
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json");
        const supplied = Buffer.from(req.headers.authorization ?? ""),
            expected = Buffer.from(`Bearer ${token}`);
        if (
            req.headers.origin ||
            req.method !== "POST" ||
            req.url !== "/runtime" ||
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)
        ) {
            res.writeHead(403).end(JSON.stringify({ error: "Forbidden" }));
            return;
        }
        try {
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 64 * 1024) {
                    res.writeHead(413).end(JSON.stringify({ error: "Request too large" }));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            }
            const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (request?.action === "ping") {
                res.end(JSON.stringify({ protocol: 1, pid: process.pid }));
                return;
            }
            if (request?.action === "stop_helper") {
                res.end(
                    JSON.stringify({
                        state: "stopped",
                        note: "The companion stopped. Running game processes are left running; held inputs expire after loss of connection.",
                    }),
                    () => {
                        void close().catch(console.error);
                    },
                );
                return;
            }
            const result = await executeRuntime(hub, runtimeRequest.parse(request));
            // CLI callers use their local image viewer, never a screen-sized base64 blob in text.
            if (result && typeof result === "object" && "mimeType" in result && "data" in result) {
                const { data, ...artifact } = result;
                res.end(
                    JSON.stringify({
                        ...artifact,
                        view: "Open the local path with your image viewing tool.",
                    }),
                );
            } else res.end(JSON.stringify(result));
        } catch (e) {
            if (!res.headersSent)
                res.writeHead(400).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const descriptor: CompanionDescriptor = {
            protocol: 1,
            pid: process.pid,
            endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/runtime`,
            token,
        };
        const temporary = join(root, `companion-${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
            await rename(temporary, descriptorPath(root));
        } finally {
            await unlink(temporary).catch(() => {});
        }
        return { hub, descriptor, close };
    } catch (e) {
        await close();
        throw e;
    }
}
