import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertJarPath, normalizeJarPath } from "./security.js";
import { validateClassName } from "./validate.js";
import { decompileClass, getBytecode } from "./java-tools.js";
import { CACHE_ROOT } from "./cache.js";

export const localModRequest = z.object({
    localJarPath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    className: z.string().min(1), operation: z.enum(["source", "bytecode"]).default("source"),
    acceptedLocalDecompilation: z.boolean().default(false),
    startLine: z.number().int().positive().default(1), maxLines: z.number().int().positive().max(10000).default(200),
});
export type LocalModRequest = z.input<typeof localModRequest>;

export async function executeLocalMod(input: LocalModRequest,
    decompile = decompileClass, bytecode = getBytecode): Promise<object> {
    const request = localModRequest.parse(input);
    if (!request.acceptedLocalDecompilation) throw new Error("Explicit user acceptance of local decompilation is required before execution.");
    const jar = normalizeJarPath(request.localJarPath);
    assertJarPath(jar);
    const name = request.className.replace(/\.(?:java|class)$/, "").replace(/\./g, "/");
    validateClassName(name);
    if (!name.split("/").every(p => /^[\p{L}\p{N}_$]+$/u.test(p))) throw new Error("Invalid className");
    const bytes = await readFile(jar);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== request.sha256) throw new Error("Local JAR hash differs from the reviewed artifact; inspect this version before accepting.");
    // Use an immutable private copy so the original path cannot change between
    // the consent/hash check and the decompiler reading it. No hosted upload.
    const dir = join(CACHE_ROOT, "local-consented-mods", hash);
    await mkdir(dir, { recursive: true });
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const invocation = await mkdtemp(join(dir, "run-"));
    const copy = join(invocation, "input.jar");
    await writeFile(copy, bytes, { flag: "wx" });
    const source = request.operation === "bytecode" ? await bytecode(copy, name) : await decompile(copy, name, join(invocation, "source"));
    const lines = source.split(/\r\n|\n|\r/);
    return { executed: true, execution: "local", sha256: hash, className: name, operation: request.operation,
        startLine: request.startLine, totalLines: lines.length, source: lines.slice(request.startLine - 1, request.startLine - 1 + request.maxLines).join("\n"),
        notice: "Decompiled locally after acceptance. Acceptance is not a license grant; retain applicable notices and do not upload restricted source to the hosted service." };
}

export async function localModCli(args: string[]): Promise<number> {
    try {
        if (args.length !== 2 || args[0] !== "--request-file") throw new Error("Usage: --local-mod --request-file <local JSON request>");
        const request = localModRequest.parse(JSON.parse(await readFile(args[1], "utf8")));
        if (!request.acceptedLocalDecompilation) {
            if (!process.stdin.isTTY) throw new Error("User acceptance required. Ask the user before setting acceptedLocalDecompilation in the local request, or run interactively.");
            const readline = createInterface({ input: process.stdin, output: process.stderr });
            try {
                const answer = await readline.question(`Decompile ${request.className} locally from ${request.localJarPath}\nSHA-256 ${request.sha256}\nThis does not grant redistribution rights. Type ACCEPT to continue: `);
                if (answer !== "ACCEPT") throw new Error("Local decompilation declined.");
                request.acceptedLocalDecompilation = true;
            } finally { readline.close(); }
        }
        console.log(JSON.stringify(await executeLocalMod(request), null, 2));
        return 0;
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
