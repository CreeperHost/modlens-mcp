import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, stat, realpath, lstat, open, unlink, rename } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import {
    agentPacket,
    properties,
    type AgentPacket,
    type RuntimeCommand,
    type RuntimeMode,
} from "./protocol.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const UUID = /^[0-9a-f-]{36}$/;
type Project = {
    id: string;
    directory: string;
    token: string;
    mode: RuntimeMode;
    task: string;
    hooks: boolean;
    mcVersion: string;
};
type Event = { cursor: number; sessionId: string; time: number; type: string; data: Record<string, unknown> };
type Command = {
    id: string;
    deadline: number;
    command: RuntimeCommand;
    sent: boolean;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
};
type Session = {
    projectId: string;
    packet: AgentPacket;
    lastSeen: number;
    lastSeq: number;
    disconnected?: boolean;
    ended?: boolean;
    commands: Map<string, Command>;
};
export const RUNTIME_HELP = {
    target: "Minecraft Java 26.3 with SDL control; older versions with LWJGL input",
    clientJvmOptions:
        "26.3 client launches require -XX:StackShadowPages=32 independently of this agent. Setup includes it in the selected Gradle client task and returns all required vmOptions for manual launches.",
    optional: true,
    workflow: [
        "setup(projectDir) prepares an opt-in IntelliJ Gradle run config and agent; no existing build file changes",
        "launch(projectId) or select ModLens Client in IntelliJ",
        "sessions, then status(sessionId) to inspect actual capabilities",
        "command(mode=observe) gives the MCP exclusive game input; hidden also hides SDL/GLFW windows; interactive returns input to the human",
        "Use the connected agent's capabilities for commands; events(afterCursor,waitMs) reports incidents",
    ],
    input: "Input uses SDL on 26.3, GLFW on 1.13–1.21, and LWJGL2 on earlier versions. Use key names such as W, SPACE and ESCAPE; mouse buttons are 1 left, 2 middle, 3 right. Inspect connected capabilities.",
    monitoring:
        "Events are collected without an AI turn. While actively monitoring, use bounded events waits. MCP notifications do not by themselves guarantee an idle AI task wakes up.",
    heapAnalysis:
        "On Java 11+, use command allocations with your mod's packagePrefix, then artifact to read the JSON hotspot report. Weighted JFR stack samples identify likely allocation-heavy callers. Combine with GC/heap metrics; this is not a retained-heap analysis or proof of a leak.",
    execution:
        "Local stdio MCP executes directly. Remote MCP returns a local execution plan: Codex runs modlens-mcp --runtime --request-file <file> on the Minecraft PC. No second MCP connection or tunnel is required.",
    limits: "Requires local execution access and an existing working dev run task. LWJGL2 cannot hide its window through the Java display API. Java 8 lacks JFR. Inspect connected capabilities.",
};

/** Local-only, opt-in bridge. Remote MCP clients never gain host process/filesystem control. */
export class RuntimeHub {
    private projects = new Map<string, Project>();
    private sessions = new Map<string, Session>();
    private journal: Event[] = [];
    private cursor = 0;
    private server?: Server;
    private endpoint = "";
    private init?: Promise<void>;
    private waiters = new Map<() => void, () => void>();
    private children = new Map<string, ChildProcess>();
    private persistence: Promise<unknown> = Promise.resolve();
    private monitor?: NodeJS.Timeout;
    private dirty = false;
    private ownsLock = false;
    private listening?: Promise<void>;
    constructor(
        readonly root: string,
        readonly agentJar = join(PACKAGE_ROOT, "dist/runtime/modlens-agent.jar"),
    ) {}

    private assertLocal() {
        if (process.env.MCP_PORT)
            throw new Error(
                "Runtime control must execute on the dev machine through local stdio or the --runtime helper. The remote MCP provides a local execution plan instead of running local paths on its host.",
            );
    }
    async initialize() {
        this.assertLocal();
        return (this.init ??= this.load().catch((e) => {
            this.init = undefined;
            throw e;
        }));
    }
    /** Explicit CLI opt-in: keep a bridge ready even before the first project setup. */
    async startLocalCompanion() {
        await this.initialize();
        await this.listen();
    }
    private async load() {
        const saved = await readFile(join(this.root, "projects.json"), "utf8").catch(
            (e: NodeJS.ErrnoException) => {
                if (e.code === "ENOENT") return "[]";
                throw e;
            },
        );
        for (const p of JSON.parse(saved) as Project[]) {
            if (UUID.test(p.id) && /^[a-f0-9]{64}$/.test(p.token) && isAbsolute(p.directory))
                this.projects.set(p.id, { ...p, mcVersion: p.mcVersion ?? "26.3" });
        }
        const history = await readFile(join(this.root, "events.json"), "utf8").catch(
            (e: NodeJS.ErrnoException) => {
                if (e.code === "ENOENT") return "[]";
                throw e;
            },
        );
        this.journal = (JSON.parse(history) as Event[]).slice(-500);
        this.cursor = this.journal.at(-1)?.cursor ?? 0;
        if (this.projects.size) await this.listen();
    }
    private async listen() {
        return (this.listening ??= this.openListener().catch(async (e) => {
            await this.close();
            this.listening = undefined;
            throw e;
        }));
    }
    private async openListener() {
        if (this.server) return;
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const lockPath = join(this.root, "bridge.lock");
        const acquire = async () => {
            const file = await open(lockPath, "wx", 0o600);
            try {
                await file.writeFile(JSON.stringify({ pid: process.pid }));
            } finally {
                await file.close();
            }
            this.ownsLock = true;
        };
        try {
            await acquire();
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
            let alive = true;
            try {
                process.kill(owner.pid, 0);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
            }
            if (alive)
                throw new Error(
                    "Another local ModLens runtime bridge owns these projects. Use that MCP connection, or stop it before starting this one. The existing client's connection was not changed.",
                );
            await unlink(lockPath);
            await acquire();
        }
        const server = createServer(async (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            // No browser access, CORS, wildcard binding, or unauthenticated control route.
            if (req.headers.origin || req.method !== "POST") {
                res.writeHead(403).end();
                return;
            }
            const match = /^\/agent\/([0-9a-f-]{36})$/.exec(req.url ?? "");
            const p = match && this.projects.get(match[1]);
            const credential = Buffer.from(req.headers.authorization ?? "");
            const expected = Buffer.from(p ? `Bearer ${p.token}` : "");
            if (!p || credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
                res.writeHead(403).end();
                return;
            }
            try {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const c of req) {
                    size += c.length;
                    if (size > 512 * 1024) {
                        res.writeHead(413).end();
                        req.destroy();
                        return;
                    }
                    chunks.push(c);
                }
                const packet = agentPacket.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                const response = this.accept(p, packet);
                res.writeHead(200, { "Content-Type": "text/plain; charset=us-ascii" }).end(
                    properties(response),
                );
            } catch {
                if (!res.headersSent) res.writeHead(400).end();
            }
        });
        server.requestTimeout = 5000;
        server.headersTimeout = 5000;
        await new Promise<void>((ok, fail) => {
            server.once("error", fail);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", fail);
                ok();
            });
        });
        this.server = server;
        server.unref();
        this.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        for (const p of this.projects.values()) await this.connection(p);
        this.monitor = setInterval(() => {
            for (const [id, s] of this.sessions)
                if (!s.ended && !s.disconnected && Date.now() - s.lastSeen > 5000) {
                    s.disconnected = true;
                    this.add(id, "connection_lost", {
                        note: "Heartbeat lost; this is not proof of a JVM crash.",
                    });
                }
            if (this.dirty) {
                this.dirty = false;
                const snapshot = this.journal.slice(-500);
                this.persistence = this.persistence
                    .then(() => this.saveEvents(snapshot))
                    .catch((e) => {
                        this.dirty = true;
                        console.error("[runtime] Could not persist events:", e);
                    });
            }
        }, 1000);
        this.monitor.unref();
    }
    private async safeDirectory(project: string, suffix: string) {
        const dest = join(project, suffix);
        let path = project;
        for (const segment of suffix.split(/[\\/]/)) {
            path = join(path, segment);
            const info = await lstat(path).catch((e: NodeJS.ErrnoException) => {
                if (e.code === "ENOENT") return null;
                throw e;
            });
            if (info?.isSymbolicLink()) throw new Error(`Refusing symlink in managed runtime path: ${path}`);
            if (info && !info.isDirectory()) throw new Error(`Expected directory: ${path}`);
            if (!info) await mkdir(path, { mode: 0o700 });
        }
        return dest;
    }
    private async managedWrite(path: string, data: string | Buffer, overwrite = true) {
        const info = await lstat(path).catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return null;
            throw e;
        });
        if (info?.isSymbolicLink() || (info && !info.isFile()))
            throw new Error(`Refusing non-file managed path: ${path}`);
        if (info && !overwrite) throw new Error(`File already exists: ${path}`);
        await writeFile(path, data, { mode: 0o600 });
    }
    private async connection(p: Project) {
        const dir = await this.safeDirectory(p.directory, ".modlens/runtime");
        const data = properties({
            protocol: 1,
            endpoint: `${this.endpoint}/agent/${p.id}`,
            token: p.token,
            projectId: p.id,
            mode: p.mode,
            minecraftHooks: p.hooks,
            mcVersion: p.mcVersion,
            artifacts: join(dir, "sessions"),
        });
        await this.managedWrite(join(dir, "connection.properties"), data);
    }
    async setup(directory: string, mode: RuntimeMode = "interactive", task = "runClient", hooks = true, mcVersion = "26.3") {
        await this.initialize();
        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(mcVersion)) throw new Error("Invalid mcVersion");
        const release = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcVersion);
        if (release && (Number(release[1]) < 7 || (Number(release[1]) === 7 && Number(release[2] ?? 0) < 10)))
            throw new Error("Runtime monitoring supports Minecraft 1.7.10 and newer");
        const modern = mcVersion === "26.3";
        if (!modern && mode === "hidden" && release && Number(release[1]) < 13)
            throw new Error("LWJGL2 clients do not support hidden mode; use interactive or observe");
        if (!isAbsolute(directory)) throw new Error("projectDir must be an absolute path on this machine");
        directory = await realpath(directory);
        if (!(await stat(directory)).isDirectory()) throw new Error("projectDir is not a directory");
        if (!/^:?[\w-]+(?::[\w-]+)*$/.test(task))
            throw new Error("gradleTask must be a Gradle task path such as :client:runClient");
        const wrapper = join(directory, "gradle/wrapper/gradle-wrapper.jar");
        await stat(wrapper).catch(() => {
            throw new Error(
                "Project needs an existing Gradle wrapper. Run setup on the mod development project, not its run/ folder.",
            );
        });
        await stat(this.agentJar).catch(() => {
            throw new Error(
                "The packaged runtime agent is missing. In a source checkout, run npm run build:agent with JAVA_HOME set to JDK 25, then retry setup.",
            );
        });
        let p = [...this.projects.values()].find((p) => p.directory === directory);
        p = {
            id: p?.id ?? randomUUID(),
            directory,
            token: p?.token ?? randomBytes(32).toString("hex"),
            mode,
            task,
            hooks,
            mcVersion,
        };
        const dir = await this.safeDirectory(directory, ".modlens/runtime");
        const runDir = await this.safeDirectory(directory, ".run");
        const runFile = join(runDir, "ModLens Client.run.xml");
        const existing = await readFile(runFile, "utf8").catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return "";
            throw e;
        });
        if (existing && !existing.includes("<!-- Managed by ModLens runtime -->"))
            throw new Error("A non-ModLens run configuration already exists at " + runFile);
        await this.managedWrite(join(dir, "agent.jar"), await readFile(this.agentJar));
        await this.managedWrite(join(dir, ".gitignore"), "*\n");
        const script = await readFile(
            join(PACKAGE_ROOT, "scripts/gradle/modlens-runtime.init.gradle"),
            "utf8",
        );
        await this.managedWrite(join(dir, "init.gradle"), script);
        await this.managedWrite(
            join(dir, "launch.properties"),
            properties({
                task,
                agent: join(dir, "agent.jar"),
                connection: join(dir, "connection.properties"),
                mcVersion,
            }),
        );
        const xml = (s: string) =>
            s
                .replaceAll("&", "&amp;")
                .replaceAll('"', "&quot;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;");
        await this.managedWrite(
            runFile,
            `<!-- Managed by ModLens runtime -->\n<component name="ProjectRunConfigurationManager">\n  <configuration default="false" name="ModLens Client" type="GradleRunConfiguration" factoryName="Gradle">\n    <ExternalSystemSettings>\n      <option name="externalProjectPath" value="$PROJECT_DIR$" />\n      <option name="externalSystemIdString" value="GRADLE" />\n      <option name="scriptParameters" value="--init-script &quot;$PROJECT_DIR$/.modlens/runtime/init.gradle&quot; --no-configuration-cache" />\n      <option name="taskNames"><list><option value="${xml(task)}" /></list></option>\n    </ExternalSystemSettings>\n    <method v="2" />\n  </configuration>\n</component>\n`,
        );
        this.projects.set(p.id, p);
        await this.listen();
        await this.connection(p);
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await this.managedWrite(
            join(this.root, "projects.json"),
            JSON.stringify([...this.projects.values()]),
        );
        const vmOption = `-javaagent:${join(dir, "agent.jar")}=${join(dir, "connection.properties")}`;
        return {
            state: "configured",
            projectId: p.id,
            mcVersion,
            mode,
            runConfiguration: runFile,
            vmOption,
            vmOptions: modern ? [vmOption, "-XX:StackShadowPages=32"] : [vmOption],
            manualLaunch:
                modern ? "Add every vmOptions entry to the actual Minecraft client JVM. StackShadowPages=32 is required for 26.3 client startup independently of the agent. The generated Gradle/IntelliJ launch includes it automatically." : "Add the vmOption to the actual Minecraft client JVM. Inspect the connected agent's input and screenshot capabilities after launch.",
            next: "Select ModLens Client in IntelliJ and Run, or call runtime.launch(projectId). Use runtime.sessions to confirm connection and capabilities.",
            files: [
                runFile,
                join(dir, "agent.jar"),
                join(dir, "connection.properties"),
                join(dir, "init.gradle"),
                join(dir, "launch.properties"),
            ],
            note: "Only this opt-in run configuration uses the agent; existing builds and run configurations are unchanged. Keep connection.properties private.",
        };
    }
    private accept(p: Project, packet: AgentPacket): Record<string, unknown> {
        let s = this.sessions.get(packet.sessionId);
        if (s && s.projectId !== p.id) throw new Error("Session project mismatch");
        if (!s) {
            if (this.sessions.size >= 64)
                throw new Error("Session limit reached; restart the bridge to clear history");
            s = { projectId: p.id, packet, lastSeen: Date.now(), lastSeq: 0, commands: new Map() };
            this.sessions.set(packet.sessionId, s);
            this.add(packet.sessionId, "session_started", { projectId: p.id, pid: packet.pid });
        }
        if (s.disconnected) this.add(packet.sessionId, "connection_restored", {});
        s.packet = packet;
        s.lastSeen = Date.now();
        s.disconnected = false;
        for (const e of packet.events)
            if (e.seq > s.lastSeq) {
                this.add(packet.sessionId, e.type, e.data, e.time);
                s.lastSeq = e.seq;
                if (e.type === "jvm_shutdown") s.ended = true;
            }
        for (const result of packet.results) {
            const c = s.commands.get(result.id);
            if (c) {
                clearTimeout(c.timer);
                s.commands.delete(c.id);
                result.ok
                    ? c.resolve({ commandId: c.id, ...(result.data as object) })
                    : c.reject(new Error(JSON.stringify(result.data)));
            }
        }
        const pending = [...s.commands.values()].find((c) => !c.sent && c.deadline > Date.now());
        if (!pending) return { ack: s.lastSeq };
        pending.sent = true;
        return { ack: s.lastSeq, id: pending.id, deadline: pending.deadline, ...pending.command };
    }
    private add(sessionId: string, type: string, data: Record<string, unknown>, time = Date.now()) {
        const e = { cursor: ++this.cursor, sessionId, time, type, data };
        this.journal.push(e);
        if (this.journal.length > 2000) this.journal.shift();
        // Coalesce writes instead of queuing one disk write per incoming event.
        this.dirty = true;
        for (const wake of this.waiters.keys()) wake();
    }
    private async saveEvents(snapshot: Event[]) {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await writeFile(join(this.root, "events.tmp"), JSON.stringify(snapshot), { mode: 0o600 });
        await rename(join(this.root, "events.tmp"), join(this.root, "events.json"));
    }
    async status(sessionId?: string) {
        await this.initialize();
        if (sessionId) {
            const s = this.session(sessionId);
            return this.view(sessionId, s);
        }
        return {
            enabled: this.projects.size > 0,
            agentPackaged: await stat(this.agentJar).then(
                () => true,
                () => false,
            ),
            projects: [...this.projects.values()].map(({ token, ...p }) => p),
            help: RUNTIME_HELP,
        };
    }
    async list() {
        await this.initialize();
        return [...this.sessions].map(([id, s]) => this.view(id, s));
    }
    private view(id: string, s: Session) {
        return {
            sessionId: id,
            projectId: s.projectId,
            status: s.ended ? "stopped" : Date.now() - s.lastSeen > 5000 ? "disconnected" : "connected",
            lastSeen: s.lastSeen,
            pid: s.packet.pid,
            javaVersion: s.packet.javaVersion,
            capabilities: s.packet.capabilities,
            state: s.packet.state,
            metrics: s.packet.metrics,
        };
    }
    private session(id: string) {
        const s = this.sessions.get(id);
        if (!s) throw new Error("Unknown sessionId; call runtime.sessions first");
        return s;
    }
    async events(after = 0, waitMs = 0, sessionId?: string) {
        await this.initialize();
        const available = () =>
            this.journal.filter((e) => e.cursor > after && (!sessionId || e.sessionId === sessionId));
        if (!available().length && waitMs > 0)
            await new Promise<void>((ok) => {
                const done = () => {
                    clearTimeout(timer);
                    this.waiters.delete(wake);
                    ok();
                };
                const wake = () => {
                    if (available().length) done();
                };
                const timer = setTimeout(done, Math.min(30_000, waitMs));
                this.waiters.set(wake, done);
            });
        const events = available().slice(0, 100);
        return {
            events,
            nextCursor: events.at(-1)?.cursor ?? this.cursor,
            truncated: after > 0 && after < (this.journal[0]?.cursor ?? 0) - 1,
        };
    }
    async command(sessionId: string, command: RuntimeCommand) {
        await this.initialize();
        const s = this.session(sessionId);
        if (s.ended || Date.now() - s.lastSeen > 5000)
            throw new Error("Client disconnected; command was not queued");
        if (s.commands.size >= 16) throw new Error("Too many commands awaiting completion");
        const id = randomUUID(),
            deadline = Date.now() + 10_000;
        return new Promise<unknown>((ok, fail) => {
            const timer = setTimeout(() => {
                s.commands.delete(id);
                fail(
                    new Error(
                        "Command timed out; execution is unknown. Inspect session state before retrying an action.",
                    ),
                );
            }, 11_000);
            s.commands.set(id, { id, deadline, command, sent: false, resolve: ok, reject: fail, timer });
        });
    }
    async launch(projectId: string, javaHome?: string) {
        await this.initialize();
        const p = this.projects.get(projectId);
        if (!p) throw new Error("Unknown projectId; call setup first");
        if (this.children.has(p.id))
            throw new Error("A ModLens Gradle launch is already running for this project");
        const java = javaHome
            ? join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java")
            : process.env.JAVA_HOME
              ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
              : "java";
        const args = [
            "-classpath",
            join(p.directory, "gradle/wrapper/gradle-wrapper.jar"),
            "org.gradle.wrapper.GradleWrapperMain",
            p.task,
            "--init-script",
            join(p.directory, ".modlens/runtime/init.gradle"),
            "--no-configuration-cache",
            "--console=plain",
        ];
        const child = spawn(java, args, {
            cwd: p.directory,
            env: javaHome ? { ...process.env, JAVA_HOME: javaHome } : process.env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.children.set(p.id, child);
        child.once("exit", (code, signal) => {
            this.children.delete(p.id);
            this.add("launch:" + p.id, "launch_exited", { code, signal });
        });
        let recent = "";
        const log = (chunk: Buffer) => {
            recent = (recent + chunk.toString()).slice(-16_000);
        };
        child.stdout?.on("data", log);
        child.stderr?.on("data", log);
        child.once("exit", () => {
            this.add("launch:" + p.id, "launch_log", { text: recent });
        });
        await new Promise<void>((ok, fail) => {
            child.once("spawn", ok);
            child.once("error", (e) => {
                this.children.delete(p.id);
                fail(e);
            });
        });
        return {
            state: "launching",
            pid: child.pid,
            projectId: p.id,
            next: "Poll runtime.sessions/events for agent registration; a Gradle PID is not proof Minecraft started.",
        };
    }
    async artifact(sessionId: string, name: string) {
        await this.initialize();
        const s = this.session(sessionId),
            p = this.projects.get(s.projectId)!;
        if (!/^[a-zA-Z0-9._-]+\.(png|jfr|txt)$/.test(name)) throw new Error("Invalid artifact name");
        const base = join(p.directory, ".modlens/runtime/sessions", sessionId);
        if (relative(base, await realpath(base)) !== "")
            throw new Error("Artifact session directory contains a symlink");
        const path = await realpath(join(base, name));
        const rel = relative(base, path);
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact escaped session directory");
        if ((await stat(path)).size > 8 * 1024 * 1024)
            return { path, note: "Artifact is larger than 8 MiB; inspect the local file." };
        if (name.endsWith(".png"))
            return { path, mimeType: "image/png", data: (await readFile(path)).toString("base64") };
        if (name.endsWith(".txt")) return { path, text: await readFile(path, "utf8") };
        return { path };
    }
    async close() {
        if (this.monitor) clearInterval(this.monitor);
        // Stopping monitoring must not kill game/Gradle processes or keep the helper
        // alive indefinitely through their logging pipes.
        for (const child of this.children.values()) {
            child.removeAllListeners("exit");
            child.unref();
            child.stdout?.destroy();
            child.stderr?.destroy();
        }
        this.children.clear();
        for (const s of this.sessions.values())
            for (const c of s.commands.values()) {
                clearTimeout(c.timer);
                c.reject(new Error("Runtime bridge closed"));
            }
        for (const done of this.waiters.values()) done();
        await this.persistence.catch(() => {});
        if (this.dirty) {
            await this.saveEvents(this.journal.slice(-500));
            this.dirty = false;
        }
        if (this.server) {
            this.server.closeAllConnections();
            await new Promise<void>((ok) => this.server!.close(() => ok()));
            this.server = undefined;
        }
        if (this.ownsLock) {
            await unlink(join(this.root, "bridge.lock")).catch(() => {});
            this.ownsLock = false;
        }
        this.listening = undefined;
    }
}
