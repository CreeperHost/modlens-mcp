// Optional real-client validation with an isolated game directory and demo mode.
// Uses the explicitly supplied 26.3 manifest/client/assets; never reads user accounts/worlds.
import { readFile, writeFile, mkdir, mkdtemp, stat, copyFile } from "node:fs/promises";
import { join, delimiter, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { RuntimeHub } from "../dist/runtime/hub.js";
import { runtimeTestClient } from "./runtime-test-client.mjs";

const env = process.env;
for (const k of [
    "JAVA_HOME",
    "MODLENS_TEST_MC_MANIFEST",
    "MODLENS_TEST_MC_CLIENT",
    "MODLENS_TEST_MC_ASSETS",
    "MODLENS_TEST_MAVEN_CACHE",
])
    if (!env[k]) throw new Error("Set " + k);
const manifest = JSON.parse(await readFile(env.MODLENS_TEST_MC_MANIFEST, "utf8"));
assert.equal(manifest.id, "26.3");
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "modlens-minecraft-smoke-"));
console.log("Evidence directory: " + root);
const project = join(root, "project");
await mkdir(join(project, "gradle/wrapper"), { recursive: true });
await writeFile(join(project, "gradle/wrapper/gradle-wrapper.jar"), "fixture");
const classpath = [env.MODLENS_TEST_MC_CLIENT];
for (const lib of manifest.libraries) {
    const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
    if (lib.rules) {
        let allowed = false;
        for (const rule of lib.rules)
            if (!rule.os || rule.os.name === osName) allowed = rule.action === "allow";
        if (!allowed) continue;
    }
    const native = lib.name.split(":")[3];
    if (
        native?.includes("natives-") &&
        native !==
            `natives-${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}${process.arch === "arm64" ? "-arm64" : ""}`
    )
        continue;
    const [group, artifact, version] = lib.name.split(":");
    const entry = lib.downloads?.artifact;
    if (!entry) continue;
    let path = join(env.MODLENS_TEST_MAVEN_CACHE, group, artifact, version, entry.sha1, basename(entry.path));
    if (
        !(await stat(path).then(
            () => true,
            () => false,
        ))
    ) {
        path = join(root, "libraries", entry.path);
        await mkdir(join(path, ".."), { recursive: true });
        const r = await fetch(entry.url);
        if (!r.ok) throw new Error("Download failed: " + entry.url);
        const data = Buffer.from(await r.arrayBuffer());
        assert.equal(createHash("sha1").update(data).digest("hex"), entry.sha1);
        await writeFile(path, data);
    }
    classpath.push(path);
}
const hub = process.argv.includes("--helper")
    ? runtimeTestClient(root)
    : new RuntimeHub(
          join(root, "bridge"),
          env.MODLENS_TEST_AGENT_JAR ?? join(repo, "dist/runtime/modlens-agent.jar"),
      );
const setup = await hub.setup(project, "hidden");
const args = [
    "--enable-native-access=ALL-UNNAMED",
    "--add-exports",
    "java.base/jdk.internal.misc=ALL-UNNAMED",
    "-Xmx2G",
    ...(env.MODLENS_TEST_JVM_ARGS ? JSON.parse(env.MODLENS_TEST_JVM_ARGS) : []),
    "-XX:ErrorFile=" + join(root, "hs_err_pid%p.log"),
    ...setup.vmOptions.filter(
        (option) => !process.argv.includes("--baseline") || !option.startsWith("-javaagent:"),
    ),
    "-cp",
    classpath.join(delimiter),
    manifest.mainClass,
    "--username",
    "ModLensTest",
    "--version",
    "26.3",
    "--gameDir",
    join(root, "game"),
    "--assetsDir",
    env.MODLENS_TEST_MC_ASSETS,
    "--assetIndex",
    env.MODLENS_TEST_MC_ASSET_INDEX ?? manifest.assetIndex.id,
    "--uuid",
    "00000000000000000000000000000001",
    "--accessToken",
    "0",
    "--demo",
    "--width",
    "854",
    "--height",
    "480",
];
await mkdir(join(root, "game"), { recursive: true });
await writeFile(
    join(root, "java.args"),
    args.map((a) => '"' + a.replaceAll("\\", "/").replaceAll('"', '\\"') + '"').join("\n"),
);
const child = spawn(
    join(env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"),
    ["@" + join(root, "java.args")],
    { cwd: join(root, "game"), windowsHide: true },
);
let log = "";
child.stdout.on("data", (b) => {
    log = (log + b).slice(-150000);
});
child.stderr.on("data", (b) => {
    log = (log + b).slice(-150000);
});
const done = new Promise((ok) => child.once("exit", ok));
async function wait(fn, ms = 90000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const r = await fn();
        if (r) return r;
        if (child.exitCode !== null)
            throw new Error("Minecraft exited " + child.exitCode + "\n" + log.slice(-8000));
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Timed out waiting for Minecraft\n" + log.slice(-8000));
}
try {
    if (process.argv.includes("--baseline")) {
        await wait(() => log.includes("shulker_boxes.png-atlas"));
        await new Promise((r) => setTimeout(r, 5000));
        assert.equal(child.exitCode, null, "Uninstrumented baseline must remain alive after startup");
        console.log("Uninstrumented Minecraft startup passed. " + root);
    } else {
        const session = await wait(async () =>
            (await hub.list()).find(
                (s) =>
                    s.capabilities.minecraftHooks && s.capabilities.window && s.state.observation?.gameLoaded,
            ),
        );
        await new Promise((r) => setTimeout(r, 1500)); // allow the startup overlay to fade
        console.log("Connected Minecraft: " + JSON.stringify(session));
        const frame = await hub.command(session.sessionId, { type: "screenshot" });
        const artifact = await hub.artifact(session.sessionId, frame.artifact);
        assert.equal(artifact.mimeType, "image/png");
        await copyFile(artifact.path, join(root, "frame.png"));
        await hub.command(session.sessionId, { type: "key", key: "TAB", down: true, holdMs: 100 });
        await hub.command(session.sessionId, { type: "release_all" });
        assert.equal(session.capabilities.jfr, true);
        const allocations = await hub.command(session.sessionId, {
            type: "allocations",
            packagePrefix: "net.minecraft",
            windowSeconds: 120,
        });
        const allocationArtifact = await hub.artifact(session.sessionId, allocations.artifact);
        const report = JSON.parse(allocationArtifact.text);
        assert.ok(report.matchedSamples > 0, "Expected Minecraft allocation samples with caller stacks");
        await copyFile(allocationArtifact.path, join(root, "allocations.json"));
        console.log("Minecraft 26.3 hidden client, screenshot, input and allocation report passed. " + root);
    }
} finally {
    if (child.exitCode === null)
        try {
            await writeFile(
                join(root, "threads.txt"),
                execFileSync(
                    join(env.JAVA_HOME, "bin", process.platform === "win32" ? "jcmd.exe" : "jcmd"),
                    [String(child.pid), "Thread.print"],
                    { timeout: 10000 },
                ),
            );
        } catch (e) {
            await writeFile(join(root, "thread-error.txt"), String(e) + "\n" + e.stderr);
        }
    await writeFile(join(root, "client.log"), log);
    await writeFile(
        join(root, "evidence.json"),
        JSON.stringify({ sessions: await hub.list(), events: await hub.events() }, null, 2),
    );
    if (child.exitCode === null) child.kill();
    await done;
    await hub.close();
}
