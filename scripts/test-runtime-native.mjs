// Real SDL smoke test. Set JAVA_HOME (25+) and MODLENS_SDL_CLASSPATH to the
// lwjgl + lwjgl-sdl Java JARs and matching native JARs. No game/account needed.
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { RuntimeHub } from "../dist/runtime/hub.js";

if (!process.env.JAVA_HOME || !process.env.MODLENS_SDL_CLASSPATH)
    throw new Error("Set JAVA_HOME and MODLENS_SDL_CLASSPATH.");
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "modlens-sdl-smoke-"));
const project = join(root, "project");
await mkdir(join(project, "gradle/wrapper"), { recursive: true });
await writeFile(join(project, "gradle/wrapper/gradle-wrapper.jar"), "fixture");
const agent = join(repo, "dist/runtime/modlens-agent.jar");
const hub = new RuntimeHub(join(root, "bridge"), agent);
const bin = (n) => join(process.env.JAVA_HOME, "bin", n + (process.platform === "win32" ? ".exe" : ""));
execFileSync(
    bin("javac"),
    ["-cp", agent, "-d", root, join(repo, "runtime-agent/test/io/modlens/runtime/NativeSmoke.java")],
    { stdio: "inherit" },
);
const setup = await hub.setup(project, "hidden");
const child = spawn(
    bin("java"),
    [
        "--enable-native-access=ALL-UNNAMED",
        setup.vmOption,
        "-cp",
        [root, agent, process.env.MODLENS_SDL_CLASSPATH].join(delimiter),
        "io.modlens.runtime.NativeSmoke",
        root,
    ],
    { windowsHide: true },
);
let log = "";
child.stdout.on("data", (b) => {
    log += b;
});
child.stderr.on("data", (b) => {
    log += b;
});
const exited = new Promise((ok, fail) => {
    child.on("exit", (code) => ok(code));
    child.on("error", fail);
});
async function wait(fn, ms = 10000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const r = await fn();
        if (r) return r;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Timed out\n" + log + "\n" + JSON.stringify(await hub.events()));
}
try {
    const s = await wait(async () =>
        (await hub.list()).find((s) => s.capabilities.inputBackend === "lwjgl-sdl3"),
    );
    assert.equal(s.state.mode, "hidden");
    assert.equal(s.capabilities.window, true);
    await hub.command(s.sessionId, { type: "key", key: "W", down: true, holdMs: 150 });
    await wait(() => log.includes("RELEASE"));
    await hub.command(s.sessionId, { type: "text", text: "hello 世界" });
    await hub.command(s.sessionId, { type: "mouse_move", x: 12, y: -5, relative: true });
    await hub.command(s.sessionId, { type: "mouse_button", button: 1, down: true, holdMs: 100 });
    await hub.command(s.sessionId, { type: "scroll", x: 0, y: 1 });
    for (const marker of ["KEY 26", "TEXT hello 世界", "MOTION", "BUTTON", "SCROLL"])
        await wait(() => log.includes(marker));
    const threads = await hub.command(s.sessionId, { type: "threads" });
    assert.match(threads.artifact, /\.txt$/);
    const recording = await hub.command(s.sessionId, { type: "recording" });
    assert.match(recording.artifact, /\.jfr$/);
    assert.match((await hub.artifact(s.sessionId, threads.artifact)).text, /ModLens telemetry/);
    const recorded = await hub.artifact(s.sessionId, recording.artifact);
    assert.equal((await readFile(recorded.path)).subarray(0, 3).toString(), "FLR");
    const allocations = await hub.command(s.sessionId, {
        type: "allocations",
        packagePrefix: "io.modlens.runtime.NativeSmoke",
        windowSeconds: 30,
        limit: 20,
    });
    const report = JSON.parse((await hub.artifact(s.sessionId, allocations.artifact)).text);
    assert.ok(report.matchedSamples > 0, "Expected real JFR allocation samples for the workload");
    assert.ok(report.hotspots.some((h) => h.site.includes("NativeSmoke.allocateFixture")));
    assert.ok(report.hotspots.every((h) => h.site.startsWith("io.modlens.runtime.NativeSmoke.")));
    const noMatch = await hub.command(s.sessionId, {
        type: "allocations",
        packagePrefix: "no.such.mod",
        windowSeconds: 30,
        limit: 20,
    });
    const empty = JSON.parse((await hub.artifact(s.sessionId, noMatch.artifact)).text);
    assert.equal(empty.matchedSamples, 0);
    assert.deepEqual(empty.hotspots, []);
    console.log("Allocation hotspot report matched " + report.matchedSamples + " real samples.");
    await hub.command(s.sessionId, { type: "mode", mode: "observe" });
    await hub.command(s.sessionId, { type: "key", key: "TAB", down: true, holdMs: 100 });
    await hub.command(s.sessionId, { type: "mode", mode: "interactive" });
    await assert.rejects(
        hub.command(s.sessionId, { type: "key", key: "W", down: true, holdMs: 100 }),
        /interactive mode/,
    );
    await hub.command(s.sessionId, { type: "mode", mode: "hidden" });
    await hub.command(s.sessionId, { type: "release_all" });
    await writeFile(join(root, "finish"), "done");
    assert.equal(await exited, 0, log);
    await wait(async () => (await hub.events()).events.some((e) => e.type === "uncaught_exception"));
    await writeFile(
        join(root, "evidence.json"),
        JSON.stringify({ sessions: await hub.list(), events: await hub.events(), log }, null, 2),
    );
    console.log("SDL runtime smoke passed. Evidence: " + root);
} finally {
    if (child.exitCode === null) child.kill();
    await hub.close();
}
