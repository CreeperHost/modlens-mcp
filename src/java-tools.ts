import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { paths, ensureDir, exists } from "./cache.js";

const VINEFLOWER_URL =
    "https://repo1.maven.org/maven2/org/vineflower/vineflower/1.10.1/vineflower-1.10.1.jar";

// mcsrc-indexer.jar lives alongside this package (copied from mcsrc-mcp build)
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_INDEXER = join(__dirname, "..", "tools", "mcsrc-indexer.jar");

export interface ClassInfo {
    name: string;
    superName: string;
    interfaces: string[];
    accessFlags: number;
    methods: Array<{ name: string; descriptor: string; access: number; }>;
    fields: Array<{ name: string; descriptor: string; access: number; }>;
}

export interface JarIndex {
    classes: ClassInfo[];
    references: Record<string, string[]>;
}

function runProcess(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        proc.stdout.on("data", (d: Buffer) => out.push(d));
        proc.stderr.on("data", (d: Buffer) => err.push(d));
        proc.on("close", (code) => {
            if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
            else reject(new Error(Buffer.concat(err).toString("utf8").slice(0, 500)));
        });
        proc.on("error", reject);
    });
}

async function findJava(): Promise<string> {
    const exe = process.platform === "win32" ? "java.exe" : "java";
    const candidates = [
        process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", exe) : null,
        "C:/Program Files/Eclipse Adoptium",
        "C:/Program Files/Java",
        "C:/Program Files/Microsoft",
        "/usr/lib/jvm",
        "/usr/local/lib/jvm",
    ].filter(Boolean) as string[];

    for (const base of candidates) {
        if (base.endsWith(exe)) {
            if (await exists(base)) return base;
            continue;
        }
        try {
            const { readdir } = await import("fs/promises");
            const entries = await readdir(base).catch(() => [] as string[]);
            const jdks = entries
                .filter((e) => /jdk-(2[1-9]|[3-9]\d)/.test(e))
                .sort()
                .reverse();
            for (const jdk of jdks) {
                const p = join(base, jdk, "bin", exe);
                if (await exists(p)) return p;
            }
        } catch {
            continue;
        }
    }
    return exe; // fall back to PATH
}

async function runJava(args: string[]): Promise<string> {
    const java = await findJava();
    return runProcess(java, args);
}

export async function ensureIndexer(): Promise<string> {
    if (await exists(paths.indexerJar)) return paths.indexerJar;
    if (await exists(BUNDLED_INDEXER)) {
        // Copy to cache so it's accessible from any cwd
        const { copyFile } = await import("fs/promises");
        await ensureDir(paths.indexerJar);
        await copyFile(BUNDLED_INDEXER, paths.indexerJar);
        return paths.indexerJar;
    }
    throw new Error(
        "mcsrc-indexer.jar not found. Copy it to tools/mcsrc-indexer.jar or build it from the mcsrc-mcp java/ directory."
    );
}

export async function ensureVineflower(): Promise<string> {
    if (await exists(paths.vineflower)) return paths.vineflower;
    await ensureDir(paths.vineflower);
    const res = await fetch(VINEFLOWER_URL);
    if (!res.ok) throw new Error(`Failed to download Vineflower: ${res.status}`);
    const writer = createWriteStream(paths.vineflower);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
    return paths.vineflower;
}

export async function indexJar(jarPath: string): Promise<JarIndex> {
    const indexer = await ensureIndexer();
    const raw = await runJava(["-jar", indexer, "index", jarPath]);
    return JSON.parse(raw) as JarIndex;
}

export async function inspectClass(jarPath: string, className: string): Promise<ClassInfo> {
    const indexer = await ensureIndexer();
    const raw = await runJava(["-jar", indexer, "inspect", jarPath, className]);
    return JSON.parse(raw) as ClassInfo;
}

export async function getBytecode(jarPath: string, className: string): Promise<string> {
    const java = await findJava();
    return runProcess(java, [
        "-cp", jarPath,
        "javap",
        "-c", "-p", "-verbose",
        className.replace(/\//g, "."),
    ]).catch(async () => {
        // javap must be called from the JDK bin directly
        const javaPath = await findJava();
        const javap = javaPath.replace(/java(\.exe)?$/, `javap$1`);
        return runProcess(javap, ["-c", "-p", "-verbose", "-classpath", jarPath,
            className.replace(/\//g, ".")]);
    });
}

export async function decompileClass(
    jarPath: string,
    className: string,
    outputDir: string
): Promise<string> {
    const vf = await ensureVineflower();
    await ensureDir(outputDir + "/");
    const java = await findJava();
    await runProcess(java, ["-jar", vf, jarPath, outputDir, "--only", className]);
    const { readFile } = await import("fs/promises");
    const outFile = join(outputDir, className + ".java");
    if (await exists(outFile)) return readFile(outFile, "utf8");
    throw new Error(`Decompiled file not found at ${outFile}`);
}

export async function decompileJar(jarPath: string, outputDir: string): Promise<void> {
    const vf = await ensureVineflower();
    await ensureDir(outputDir + "/");
    const java = await findJava();
    await runProcess(java, ["-jar", vf, jarPath, outputDir]);
}
