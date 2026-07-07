import { spawn } from "child_process";
import { createWriteStream, mkdirSync } from "fs";
import { pipeline } from "stream/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { paths, ensureDir, exists, CACHE_ROOT } from "./cache.js";

/** Directory where JVM crash logs (hs_err_pid*.log) are written. */
const JVM_LOG_DIR = join(CACHE_ROOT, "logs");

/** JVM flags to redirect crash logs away from cwd into the cache dir. */
function jvmErrorFlags(): string[] {
    try { mkdirSync(JVM_LOG_DIR, { recursive: true }); } catch { /* ignore */ }
    const pat = join(JVM_LOG_DIR, "hs_err_pid%p.log").replace(/\\/g, "/");
    return [`-XX:ErrorFile=${pat}`];
}

const VINEFLOWER_URL =
    "https://repo1.maven.org/maven2/org/vineflower/vineflower/1.10.1/vineflower-1.10.1.jar";

// Auto-downloaded on first use, cached to ~/.modlens-cache/tools/
const INDEXER_URL =
    "https://github.com/CreeperHost/modlens-mcp/releases/download/tools-v1/mcsrc-indexer.jar";

// Fallback: local copy alongside this package (present in dev checkout)
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_INDEXER = join(__dirname, "..", "tools", "mcsrc-indexer.jar");
const PKG_ROOT = join(__dirname, "..");
const LOCAL_JDK_ROOT = join(PKG_ROOT, ".jdk");

export interface ClassInfo {
    name: string;
    superName: string;
    interfaces: string[];
    accessFlags: number;
    methods: Array<{ name: string; descriptor: string; access: number; }>;
    fields: Array<{ name: string; descriptor: string; access: number; }>;
}

export interface JarIndex {
    classes: Record<string, ClassInfo>;
    references: Record<string, string[]>;
}

function runProcess(cmd: string, args: string[], opts?: { cwd?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts?.cwd });
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

async function findJavaInDir(base: string, exe: string): Promise<string | false> {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const p = join(base, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "bin") {
                const java = join(p, exe);
                if (await exists(java)) return java;
            }
            const found = await findJavaInDir(p, exe);
            if (found) return found;
        }
    }
    return false;
}

function adoptiumPlatform(): string {
    if (process.platform === "win32") return "windows";
    if (process.platform === "darwin") return "mac";
    return "linux";
}

function adoptiumArch(): string {
    if (process.arch === "arm64") return "aarch64";
    return "x64";
}

async function ensureAdoptiumJdk(major = 21): Promise<string> {
    const exe = process.platform === "win32" ? "java.exe" : "java";
    const target = join(LOCAL_JDK_ROOT, "jdk-" + major);
    const cached = await findJavaInDir(target, exe);
    if (cached) return cached;

    const { rm, mkdir, chmod } = await import("fs/promises");
    await mkdir(target, { recursive: true });

    const platform = adoptiumPlatform();
    const archive = join(LOCAL_JDK_ROOT, "jdk-" + major + (process.platform === "win32" ? ".zip" : ".tar.gz"));
    const url = "https://api.adoptium.net/v3/binary/latest/" + major + "/ga/" + platform + "/" + adoptiumArch() + "/jdk/hotspot/normal/eclipse?project=jdk";
    console.error("[modlens] Downloading JDK " + major + " from Adoptium for decompiling/indexing...");
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error("Failed to download JDK " + major + " from Adoptium: HTTP " + res.status);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(archive));

    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    if (process.platform === "win32") {
        const AdmZip = (await import("adm-zip")).default;
        new AdmZip(archive).extractAllTo(target, true);
    } else {
        await runProcess("tar", ["-xzf", archive, "-C", target]);
    }

    const java = await findJavaInDir(target, exe);
    if (!java) throw new Error("Downloaded JDK " + major + " but could not find java executable in " + target);
    if (process.platform !== "win32") await chmod(java, 0o755).catch(() => {});
    console.error("[modlens] Cached JDK " + major + " at " + target);
    return java;
}

async function findJava(): Promise<string> {
    const exe = process.platform === "win32" ? "java.exe" : "java";

    const bundled = await findJavaInDir(LOCAL_JDK_ROOT, exe);
    if (bundled) return bundled;

    const searchDirs = [
        "C:/Program Files/Eclipse Adoptium",
        "C:/Program Files/Java",
        "C:/Program Files/Microsoft",
        "/usr/lib/jvm",
        "/usr/local/lib/jvm",
    ];

    // Prefer JDK 21+ from well-known install dirs
    for (const base of searchDirs) {
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

    // Fall back to JAVA_HOME if it's set
    if (process.env.JAVA_HOME) {
        const p = join(process.env.JAVA_HOME, "bin", exe);
        if (await exists(p)) return p;
    }

    try {
        return await ensureAdoptiumJdk(21);
    } catch (err) {
        console.error("[modlens] Failed to provision JDK 21, falling back to PATH java: " + String(err));
        return exe;
    }
}

async function runJava(args: string[]): Promise<string> {
    const java = await findJava();
    return runProcess(java, [...jvmErrorFlags(), ...args]);
}

export async function ensureIndexer(): Promise<string> {
    // 1. Already in cache
    if (await exists(paths.indexerJar)) return paths.indexerJar;

    // 2. Local dev copy (present in a dev checkout alongside tools/)
    if (await exists(BUNDLED_INDEXER)) {
        const { copyFile } = await import("fs/promises");
        await ensureDir(paths.indexerJar);
        await copyFile(BUNDLED_INDEXER, paths.indexerJar);
        return paths.indexerJar;
    }

    // 3. Auto-download from GitHub release
    console.error(`[modlens] Downloading mcsrc-indexer.jar from ${INDEXER_URL} …`);
    await ensureDir(paths.indexerJar);
    const res = await fetch(INDEXER_URL);
    if (!res.ok || !res.body)
        throw new Error(`Failed to download mcsrc-indexer.jar: HTTP ${res.status}. ` +
            `Check that the release exists at ${INDEXER_URL}`);
    const writer = createWriteStream(paths.indexerJar);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, writer);
    console.error("[modlens] mcsrc-indexer.jar downloaded and cached.");
    return paths.indexerJar;
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
    // Vineflower CLI form is `[options] {in}+ [out]`: options must use `=` and
    // precede the positional args. Passing `--only <class>` as two trailing
    // tokens makes Vineflower swallow `--only` as a boolean flag and treat the
    // class as the *output destination* — a relative path resolved against CWD,
    // which fails when CWD isn't writable (e.g. /app in the container). Pin cwd
    // to the writable output dir as defense-in-depth against any future misparse.
    await runProcess(java, ["-jar", vf, `--only=${className}`, jarPath, outputDir], { cwd: outputDir });
    const { readFile } = await import("fs/promises");
    const outFile = join(outputDir, className + ".java");
    if (await exists(outFile)) return readFile(outFile, "utf8");
    throw new Error(`Decompiled file not found at ${outFile}`);
}

/** Sentinel files written by the background decompile process */
export function decompileSentinelDone(outputDir: string) { return outputDir + "/.decompile.done"; }
export function decompileSentinelErr(outputDir: string)  { return outputDir + "/.decompile.error"; }

export async function isDecompileDone(outputDir: string): Promise<"done" | "error" | "running" | "not_started"> {
    if (await exists(decompileSentinelDone(outputDir))) return "done";
    if (await exists(decompileSentinelErr(outputDir)))  return "error";
    if (await exists(outputDir)) return "running";
    return "not_started";
}

/**
 * Launches Vineflower as a detached background process and returns immediately.
 * Writes `outputDir/.decompile.done` or `outputDir/.decompile.error` when finished.
 * Call `isDecompileDone(outputDir)` to poll status.
 */
export async function decompileJar(jarPath: string, outputDir: string): Promise<void> {
    const vf = await ensureVineflower();
    await ensureDir(outputDir + "/");
    const java = await findJava();

    // Remove stale sentinels from a previous attempt
    const { unlink } = await import("fs/promises");
    await unlink(decompileSentinelDone(outputDir)).catch(() => {});
    await unlink(decompileSentinelErr(outputDir)).catch(() => {});

    const { writeFile } = await import("fs/promises");

    // Spawn detached so the MCP process doesn't block waiting for it
    const proc = spawn(java, [...jvmErrorFlags(), "-jar", vf, jarPath, outputDir], {
        stdio: "ignore",
        detached: true,
    });
    proc.unref();

    // Write sentinel asynchronously — this promise is NOT awaited by the caller
    const pid = proc.pid;
    (async () => {
        await new Promise<void>((resolve) => {
            proc.on("close", (code) => {
                const sentinel = code === 0
                    ? decompileSentinelDone(outputDir)
                    : decompileSentinelErr(outputDir);
                writeFile(sentinel, String(code ?? "signal")).catch(() => {});
                resolve();
            });
            proc.on("error", () => {
                writeFile(decompileSentinelErr(outputDir), "spawn-error").catch(() => {});
                resolve();
            });
        });
    })();

    // Give the process a moment to confirm it actually started
    await new Promise<void>((res) => setTimeout(res, 300));
    if (!pid) throw new Error("Failed to spawn Vineflower process");
}

/**
 * Decompile a JAR into outputDir, with Jar-in-Jar (JiJ) support.
 * If the JAR contains nested JARs under META-INF/jars/ (Fabric API bundle pattern),
 * each nested JAR is extracted to a temp dir, decompiled sequentially into outputDir,
 * then the done sentinel is written once all are complete.
 *
 * For normal JARs (no nesting) this behaves identically to decompileJar().
 */
export async function decompileJarJiJ(jarPath: string, outputDir: string): Promise<void> {
    const AdmZip = (await import("adm-zip")).default;
    const { writeFile, mkdir } = await import("fs/promises");
    const zip = new AdmZip(jarPath);
    const nestedEntries = zip.getEntries().filter(
        (e) => (e.entryName.startsWith("META-INF/jars/") || e.entryName.startsWith("META-INF/jarjar/"))
            && e.entryName.endsWith(".jar")
    );

    if (nestedEntries.length === 0) {
        // Plain JAR — use the original background launcher
        return decompileJar(jarPath, outputDir);
    }

    const vf = await ensureVineflower();
    const java = await findJava();
    await mkdir(outputDir, { recursive: true });

    // Remove stale sentinels
    const { unlink } = await import("fs/promises");
    await unlink(decompileSentinelDone(outputDir)).catch(() => {});
    await unlink(decompileSentinelErr(outputDir)).catch(() => {});

    // Kick off background worker that decompiles the main JAR + nested JARs sequentially
    (async () => {
        const tmpDir = join(tmpdir(), "modlens-jij-" + Date.now());
        await mkdir(tmpDir, { recursive: true });
        try {
            // 1. Decompile the main JAR itself (contains the mod's own classes)
            await new Promise<void>((resolve, reject) => {
                const proc = spawn(java, [...jvmErrorFlags(), "-jar", vf, jarPath, outputDir], { stdio: "ignore" });
                proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Vineflower exited ${code} for main JAR`)));
                proc.on("error", reject);
            });

            // 2. Decompile each nested JAR (bundled dependencies)
            for (const entry of nestedEntries) {
                const buf = zip.readFile(entry);
                if (!buf) continue;
                const nestedJarPath = join(tmpDir, entry.entryName.replace(/\//g, "_"));
                await writeFile(nestedJarPath, buf);

                await new Promise<void>((resolve, reject) => {
                    const proc = spawn(java, [...jvmErrorFlags(), "-jar", vf, nestedJarPath, outputDir], { stdio: "ignore" });
                    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Vineflower exited ${code} for ${entry.entryName}`)));
                    proc.on("error", reject);
                });
            }
            await writeFile(decompileSentinelDone(outputDir), "0");
        } catch (err) {
            await writeFile(decompileSentinelErr(outputDir), String(err)).catch(() => {});
        }
    })();

    // Brief pause to confirm the worker started
    await new Promise<void>((res) => setTimeout(res, 300));
}
