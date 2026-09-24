import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = join(root, ".scratch");
await mkdir(scratch, { recursive: true });
// A clean output directory prevents removed/renamed classes leaking into the JAR.
const build = await mkdtemp(join(scratch, "runtime-build-"));
const output = join(root, "dist/runtime");
const asmJar = join(root, "runtime-agent/vendor/asm-9.9.1.jar");
const asmSha256 = "6f3828a215c920059a5efa2fb55c233d6c54ec5cadca99ce1b1bdd10077c7ddd";
const relocate = (bytes) => {
    const source = Buffer.from("org/objectweb/asm");
    const target = Buffer.from("io/modlens/asm/v1");
    if (source.length !== target.length) throw new Error("ASM relocation must preserve class-file lengths");
    const output = Buffer.from(bytes);
    for (let at = output.indexOf(source); at !== -1; at = output.indexOf(source, at + target.length))
        target.copy(output, at);
    const dottedSource = Buffer.from("org.objectweb.asm");
    const dottedTarget = Buffer.from("io.modlens.asm.v1");
    for (let at = output.indexOf(dottedSource); at !== -1; at = output.indexOf(dottedSource, at + dottedTarget.length))
        dottedTarget.copy(output, at);
    return output;
};
const javaTool = (name) =>
    process.env.JAVA_HOME
        ? join(process.env.JAVA_HOME, "bin", name + (process.platform === "win32" ? ".exe" : ""))
        : name;
const legacyJavaTool = (name) => {
    const home = process.env.MODLENS_LEGACY_JAVA_HOME || process.env.JAVA_HOME_17_X64;
    return home ? join(home, "bin", name + (process.platform === "win32" ? ".exe" : "")) : javaTool(name);
};
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
    const legacyFiles = await sources(join(root, "runtime-agent/legacy"));
    const files = await sources(join(root, "runtime-agent/src"));
    // javac argument files avoid Windows command length limits and handle spaces.
    const vendor = await readFile(asmJar);
    if (createHash("sha256").update(vendor).digest("hex") !== asmSha256)
        throw new Error("Vendored ASM checksum mismatch");
    const legacyArgs = ["--release", "8", "-cp", asmJar, "-d", build, ...legacyFiles];
    await writeFile(
        join(build, "legacy.args"),
        legacyArgs.map((a) => `"${a.replaceAll("\\", "/").replaceAll('"', '\\"')}"`).join("\n"),
    );
    execFileSync(legacyJavaTool("javac"), ["@" + join(build, "legacy.args")], { stdio: "inherit" });
    const jfrFiles = await sources(join(root, "runtime-agent/jfr11"));
    const jfrArgs = ["--release", "11", "-cp", build, "-d", build, ...jfrFiles];
    await writeFile(
        join(build, "jfr.args"),
        jfrArgs.map((a) => `"${a.replaceAll("\\", "/").replaceAll('"', '\\"')}"`).join("\n"),
    );
    execFileSync(legacyJavaTool("javac"), ["@" + join(build, "jfr.args")], { stdio: "inherit" });
    const classes = async (dir) => (await readdir(dir, { withFileTypes: true })).flatMap((entry) =>
        entry.isDirectory() ? [join(dir, entry.name)] : entry.name.endsWith(".class") ? [join(dir, entry.name)] : []);
    const relocateTree = async (dir) => {
        for (const entry of await classes(dir)) {
            if (entry.endsWith(".class")) await writeFile(entry, relocate(await readFile(entry)));
            else await relocateTree(entry);
        }
    };
    await relocateTree(join(build, "io"));
    const asm = new AdmZip(vendor);
    for (const entry of asm.getEntries()) {
        if (!entry.entryName.startsWith("org/objectweb/asm/") || !entry.entryName.endsWith(".class")) continue;
        const destination = join(build, entry.entryName.replace("org/objectweb/asm/", "io/modlens/asm/v1/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, relocate(entry.getData()));
    }
    const license = join(build, "META-INF/licenses/ASM.txt");
    await mkdir(dirname(license), { recursive: true });
    await writeFile(license, await readFile(join(root, "runtime-agent/vendor/ASM-LICENSE.txt")));
    const args = ["-cp", build, "-d", build, ...files];
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
        legacyJavaTool("jar"),
        [
            "--create",
            "--file",
            join(output, "modlens-agent.jar"),
            "--manifest",
            join(build, "MANIFEST.MF"),
            "-C",
            build,
            "io",
            "-C",
            build,
            "META-INF/licenses",
        ],
        { stdio: "inherit" },
    );
    console.log("Built " + resolve(output, "modlens-agent.jar"));
} finally {
    if (dirname(resolve(build)) !== resolve(scratch)) throw new Error("Unexpected build cleanup path");
    await rm(build, { recursive: true, force: true });
}
