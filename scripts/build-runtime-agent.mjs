import { mkdir, mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = join(root, ".scratch");
await mkdir(scratch, { recursive: true });
// A clean output directory prevents removed/renamed classes leaking into the JAR.
const build = await mkdtemp(join(scratch, "runtime-build-"));
const output = join(root, "dist/runtime");
const javaTool = (name) =>
    process.env.JAVA_HOME
        ? join(process.env.JAVA_HOME, "bin", name + (process.platform === "win32" ? ".exe" : ""))
        : name;
async function sources(dir) {
    return (
        await Promise.all(
            (await readdir(dir, { withFileTypes: true })).map((e) =>
                e.isDirectory()
                    ? sources(join(dir, e.name))
                    : e.name.endsWith(".java")
                      ? [join(dir, e.name)]
                      : [],
            ),
        )
    ).flat();
}
try {
    await mkdir(output, { recursive: true });
    const version = execFileSync(javaTool("javac"), ["-version"], { encoding: "utf8" });
    if (Number(/javac (\d+)/.exec(version)?.[1]) < 25)
        throw new Error("Building the runtime agent requires JDK 25+. Set JAVA_HOME.");
    const files = await sources(join(root, "runtime-agent/src"));
    // javac argument files avoid Windows command length limits and handle spaces.
    const args = ["--release", "25", "-d", build, ...files];
    await writeFile(
        join(build, "javac.args"),
        args.map((a) => `"${a.replaceAll("\\", "/").replaceAll('"', '\\"')}"`).join("\n"),
    );
    execFileSync(javaTool("javac"), ["@" + join(build, "javac.args")], { stdio: "inherit" });
    await writeFile(
        join(build, "MANIFEST.MF"),
        "Manifest-Version: 1.0\nPremain-Class: io.modlens.runtime.Agent\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n\n",
    );
    execFileSync(
        javaTool("jar"),
        [
            "--create",
            "--file",
            join(output, "modlens-agent.jar"),
            "--manifest",
            join(build, "MANIFEST.MF"),
            "-C",
            build,
            "io",
        ],
        { stdio: "inherit" },
    );
    console.log("Built " + resolve(output, "modlens-agent.jar"));
} finally {
    if (dirname(resolve(build)) !== resolve(scratch)) throw new Error("Unexpected build cleanup path");
    await rm(build, { recursive: true, force: true });
}
