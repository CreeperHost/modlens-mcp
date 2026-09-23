// Validates the same wrapper/init-script path used by MCP and IntelliJ.
// Requires JAVA_HOME (25+) and MODLENS_TEST_GRADLE_HOME (a Gradle 9.6 distribution).
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { RuntimeHub } from "../dist/runtime/hub.js";
import { runtimeTestClient } from "./runtime-test-client.mjs";

const gradleHome = process.env.MODLENS_TEST_GRADLE_HOME;
const javaHome = process.env.JAVA_HOME;
if (!gradleHome || !javaHome) throw new Error("Set JAVA_HOME and MODLENS_TEST_GRADLE_HOME");
const root = await mkdtemp(join(tmpdir(), "modlens-runtime-gradle-"));
const project = join(root, "project with spaces");
await mkdir(join(project, "src/main/java"), { recursive: true });
await writeFile(join(project, "settings.gradle"), "rootProject.name = 'runtime-smoke'\n");
await writeFile(join(project, "gradle.properties"), "org.gradle.daemon=false\n");
await writeFile(
    join(project, "build.gradle"),
    `
plugins { id 'java' }
tasks.register('runClient', JavaExec) {
    classpath = sourceSets.main.runtimeClasspath
    mainClass = 'Fixture'
    args 'agent'
}
tasks.register('plainRun', JavaExec) {
    classpath = sourceSets.main.runtimeClasspath
    mainClass = 'Fixture'
    args 'plain'
}
`,
);
await writeFile(
    join(project, "src/main/java/Fixture.java"),
    `
public class Fixture {
    public static void main(String[] args) throws Exception {
        long count = java.lang.management.ManagementFactory.getRuntimeMXBean().getInputArguments()
            .stream().filter(s -> s.startsWith("-javaagent:") && s.contains(".modlens")).count();
        if (count != (args[0].equals("agent") ? 1 : 0)) throw new AssertionError("agent count " + count);
        System.out.println("AGENT_COUNT=" + count);
        var vmArgs = java.lang.management.ManagementFactory.getRuntimeMXBean().getInputArguments();
        boolean hasShadowOption = vmArgs.stream().anyMatch(s -> s.startsWith("-XX:StackShadowPages="));
        if (hasShadowOption != args[0].equals("agent")) throw new AssertionError("Stack setting leaked or missing: " + vmArgs);
        if (count == 1) {
            String shadowPages = java.lang.management.ManagementFactory.getPlatformMXBean(
                com.sun.management.HotSpotDiagnosticMXBean.class).getVMOption("StackShadowPages").getValue();
            if (!shadowPages.equals("32")) throw new AssertionError("Effective StackShadowPages=" + shadowPages);
            System.out.println("STACK_SHADOW_PAGES=" + shadowPages);
        }
        if (count == 1) Thread.sleep(4000);
    }
}
`,
);
const launcher = (await readdir(join(gradleHome, "lib"))).find((n) =>
    /^gradle-gradle-cli-main-.*\.jar$/.test(n),
);
if (!launcher) throw new Error("Expected a Gradle 9.6 distribution");
const java = join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
execFileSync(java, ["-jar", join(gradleHome, "lib", launcher), "--no-daemon", "--offline", "wrapper"], {
    cwd: project,
    stdio: "inherit",
    timeout: 120000,
});
const hub = process.argv.includes("--helper")
    ? runtimeTestClient(root)
    : new RuntimeHub(join(root, "bridge"));
try {
    const setup = await hub.setup(project, "hidden");
    const init = join(project, ".modlens/runtime/init.gradle");
    const plain = execFileSync(
        java,
        [
            "-jar",
            join(gradleHome, "lib", launcher),
            "--no-daemon",
            "--offline",
            "--no-configuration-cache",
            "-I",
            init,
            "plainRun",
        ],
        { cwd: project, encoding: "utf8", timeout: 120000 },
    );
    assert.match(plain, /AGENT_COUNT=0/);
    await hub.launch(setup.projectId, javaHome);
    const deadline = Date.now() + 120000;
    let done;
    while (Date.now() < deadline) {
        const events = (await hub.events()).events;
        done = events.find((e) => e.type === "launch_log");
        if (done) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(done, "Gradle launch did not finish");
    assert.match(done.data.text, /AGENT_COUNT=1/);
    assert.match(done.data.text, /STACK_SHADOW_PAGES=32/);
    assert.match(done.data.text, /BUILD SUCCESSFUL/);
    assert.equal((await hub.list()).length, 1, "Only the game task should register");
    assert.match(await readFile(setup.runConfiguration, "utf8"), /--init-script/);
    console.log("Gradle optional agent launch passed. Evidence: " + root);
} finally {
    await hub.close();
}
