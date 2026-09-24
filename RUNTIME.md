# Optional live Minecraft development runtime

ModLens can launch or detect a Minecraft development client and observe JVM
health and failures. One Java agent JAR supports Minecraft 1.7.10 and newer.
It hooks SDL on 26.3, GLFW on 1.13–1.21, and LWJGL2 on 1.7.10–1.12.2 for
input and screenshots. JFR diagnostics are available when the game runs on
Java 11 or newer.
Desktop automation and an IntelliJ plugin are not required.

## Let the AI set it up

Use your existing **remote or local** ModLens MCP connection and ask:

> Set up ModLens runtime monitoring for this 26.3 mod project. Let me launch it
> from IntelliJ, and keep the client visible but watch-only while you control it.

The always-discoverable `runtime` MCP tool describes this workflow. The AI calls:

```json
{"action":"setup","projectDir":"F:/Git/my-mod","mcVersion":"26.3","mode":"observe","gradleTask":"runClient"}
```

For an older client, specify its version. For example:

```json
{"action":"setup","projectDir":"F:/Git/my-old-mod","mcVersion":"1.7.10","mode":"observe","gradleTask":"runClient"}
```

With local stdio, that tool call executes directly. With remote MCP, it returns
`executed:false` and a **local execution plan**. Codex writes the supplied JSON
request to a local file and invokes the version-matched helper through its local
terminal tools. A returned plan is not a completed setup or game action.

For example, save the setup JSON above as `runtime-request.json`, then run on the
Minecraft PC (use the package version returned by your remote MCP):

```sh
npx -y @creeperhost/modlens-mcp@<version> --runtime --request-file runtime-request.json
```

For this unpublished source build, use the built checkout instead:

```sh
node /path/to/modlens-mcp/dist/launcher.js --runtime --request-file runtime-request.json
```

The helper automatically starts an authenticated loopback companion. It stays
running between commands, detects configured IntelliJ launches, and collects
events while Codex is doing other work. It requires Node.js and a JDK supported by
the Minecraft client (Java 8 or newer); it does not bootstrap a source database or modify
MCP configuration. There is no second local MCP connection, Cloudflare dependency,
public runtime endpoint, or automatic upload of diagnostics to remote ModLens.
Codex must have local terminal/file access on the Minecraft PC; a cloud-only shell
does not provide that access.

All JSON requests in this document work through the helper. Short commands are
also available:

```sh
modlens-mcp --runtime help
modlens-mcp --runtime sessions
modlens-mcp --runtime status
modlens-mcp --runtime stop
```

Use the same `npx ...` or `node .../dist/launcher.js` prefix if the command is not
installed globally. The companion stores its private credentials and journal in
`<MODLENS_CACHE_ROOT>/runtime` (by default `~/.modlens-cache/runtime`). Stop ends
monitoring, leaving running game processes alive; held inputs expire on connection
loss. Switch to interactive mode first if you want to continue playing manually.
The next helper request starts it again. An existing local stdio bridge and the
helper cannot own the same runtime cache simultaneously; stop the current owner
before switching between these two arrangements.
Stop and restart the companion when switching package versions so it runs the
helper code and bundled agent from the selected installation.

Successful local setup copies the bundled agent into the project and creates **ModLens Client** in
IntelliJ's run configurations. Select that configuration and press Run. The AI can
also call `runtime` with `action:"launch"` and the returned `projectId`; supply
`javaHome` if the server's `JAVA_HOME` does not select a suitable JDK.

For multi-project builds, select the actual client task, e.g. `:fabric:runClient`.
The task must extend Gradle `JavaExec`. A generated init script adds the agent to
that task only. Custom launch plugins which don't expose a JavaExec task get an
actionable error. Setup also returns `vmOptions` for the actual game JVM in an
existing Application run configuration. For 26.3, add every entry, including
`-XX:StackShadowPages=32`: that client needs this setting independently of the
agent. Older versions receive only the agent VM option. The generated Gradle/IntelliJ launch supplies the required options, only to the
selected client task. **Do not put these options on IntelliJ itself or the Gradle
daemon.** Quote each whole VM option if it contains spaces. The singular `vmOption`
field remains available for callers that only need the agent argument.

Setup only creates `.modlens/runtime/` and `.run/ModLens Client.run.xml`. It does
not edit existing run configurations or build files, and refuses to overwrite a
non-ModLens run configuration. `.modlens/runtime/` contains a local `.gitignore`:
its connection token and runtime files must stay private. Published npm releases
include the compiled agent; end users do not need to compile it.

## Modes

| Mode | Display | Input |
| --- | --- | --- |
| `interactive` | Visible game window | Human controls; MCP input rejected |
| `observe` | Visible game window | MCP controls; physical game input filtered |
| `hidden` | Hidden game window (SDL/GLFW) | MCP controls; physical game input filtered |

Switch a connected client with:

```json
{"action":"command","sessionId":"<id>","command":{"type":"mode","mode":"hidden"}}
```

Observe mode uses the actual game window as a watch-only display. OS window
management, including closing it, remains available. Hidden mode still uses a
graphics device and desktop/display environment; it is not a GPU-free server.
LWJGL2 clients support `interactive` and `observe`; their Java display API does
not support hidden mode. Input interception covers the normal LWJGL paths. Mods using another native input
path need a separate adapter. This is a development convenience, not an OS security
boundary. Switching to interactive returns control; click the game to resume mouse
capture normally.

## AI workflow and tool examples

1. `help` / `status`: discover setup, configured projects, and whether the JAR is packaged.
2. `setup`: prepare a specific project (explicitly opts it in).
3. `launch`, or let the developer use IntelliJ.
4. `sessions`: discover client session IDs, PID, connection status and capabilities.
5. `status` with a session ID: read metrics, mode, screen, world state and coordinates.
6. `events` with `afterCursor` and `waitMs:30000`: wait for new events without flooding context.
7. `command`: send input or request diagnostic artifacts; `artifact` reads the result.

```json
{"action":"command","sessionId":"<id>","command":{"type":"key","key":"W","down":true,"holdMs":500}}
{"action":"command","sessionId":"<id>","command":{"type":"mouse_move","x":20,"y":-5,"relative":true}}
{"action":"command","sessionId":"<id>","command":{"type":"mouse_button","button":1,"down":true,"holdMs":100}}
{"action":"command","sessionId":"<id>","command":{"type":"text","text":"Hello"}}
{"action":"command","sessionId":"<id>","command":{"type":"screenshot"}}
{"action":"artifact","sessionId":"<id>","artifactName":"<returned artifact name>"}
```

Key names include A–Z, 0–9, SPACE, ENTER, ESCAPE, TAB, arrows, modifiers and F1–F12.
Numeric strings outside single digits represent backend-specific key codes. Mouse buttons are
1=left, 2=middle, 3=right. Coordinates are **window pixels**, not scaled GUI units;
relative movements are deltas. Text sends text-input events independently of keys.
`scroll` accepts `x` and `y`. Inputs are delivered to the event loop; they do not
guarantee a particular gameplay result. Observe state or take a screenshot afterward.

Held keys/buttons expire within 10 seconds, and are released when the bridge has
been unreachable for five seconds (as soon as the game event loop runs). Use
`release_all` to cancel held inputs. Commands have deadlines and aren't replayed
automatically after uncertain delivery. A timeout means execution is unknown;
inspect state before retrying an action.

On 26.3, screenshots use Minecraft's screenshot API after
`state.observation.gameLoaded` becomes true. GLFW and LWJGL2 clients capture the OpenGL framebuffer. PNGs are returned as MCP image content
by `artifact` over local stdio MCP. The CLI returns the local PNG path for Codex's
image viewer instead of base64 in terminal text. `threads` writes a thread dump including detected deadlock IDs;
`recording` writes the recent JFR recording. Files live under
`.modlens/runtime/sessions/<sessionId>/`. Diagnostic artifacts are local and may
contain application data; delete old session directories when finished.

## Monitoring and failure semantics

The agent samples heap/non-heap usage, thread counts and GC counters every second.
On Java 11+, it keeps a bounded two-minute/16 MiB JFR recording. It captures uncaught exceptions while
chaining the previous handler, and hooks the game's fatal crash reporting path.
It does not intercept every logged/caught exception or exceptions consumed by a
custom per-thread handler. The optional Minecraft crash hook covers the normal
client fatal-report path independently of the default uncaught handler.
Memory-pressure alerts combine sustained collection activity with heap pressure.
Collection time can include concurrent GC work: it is **not** a stop-the-world
pause percentage or proof of a memory leak.

For allocation churn in your own mod, request a report and read its returned
artifact through MCP:

```json
{"action":"command","sessionId":"<id>","command":{"type":"allocations","packagePrefix":"com.example.mymod","windowSeconds":30,"limit":20}}
{"action":"artifact","sessionId":"<id>","artifactName":"<returned artifact name>"}
```

The JSON report groups JFR allocation samples by allocated class and matching
caller, with sample weights and example stacks. Filtering matches callers in the
package, so allocations made inside Java/Minecraft libraries on behalf of the mod
can appear too. Omit the filter to inspect all sampled allocation sites. These are
statistical estimates of allocation pressure, not exact byte counts or retained
object sizes. Empty or sparse samples are inconclusive; reproduce the workload
and compare reports alongside heap/GC metrics. Reports use the bounded rolling JFR
recording, which may contain less history than the requested 5–120 seconds.
No heap dump or full-GC operation is requested. Retaining paths and GC roots are
outside this first version. See the [JFR sample-weight definition](https://github.com/openjdk/jdk/blob/jdk-25-ga/src/hotspot/share/jfr/metadata/metadata.xml).

The bridge keeps bounded event history with cursors, deduplicates agent replays,
and persists a rolling journal. A new JVM gets a new session ID. Connection loss
is reported separately from a crash; native failures/OOM may prevent in-process
delivery. The generated Gradle run redirects JVM fatal-error logs into
`.modlens/runtime/`. Commands and telemetry never use Minecraft's network protocol.

An active AI task can monitor using bounded event waits. Capturing an event does
not guarantee an idle Codex task wakes up; host scheduling is separate from MCP.

## Scope and maintenance

- Source-analysis use starts no runtime listener. An explicit local helper command
  starts its loopback companion; only setup opts a project in, and only launch
  starts a client process.
- A previously configured local project reconnects when its ModLens server starts.
- One local bridge owns a runtime cache at a time; a second connection reports the
  existing owner instead of stealing active clients. Multiple game sessions are
  supported through that bridge.
- HTTP MCP returns explicit local execution plans. The local helper performs
  runtime actions on the Minecraft PC using the same request schema and dispatcher
  as local stdio MCP. HTTP handlers never execute user-supplied local paths.
- The agent connects only to authenticated loopback HTTP; no browser control routes.
- SDL events, keyboard state and mouse state are kept consistent by `SdlAdapter`;
  optional 26.3 game APIs live in `Minecraft263`. GLFW and LWJGL2 input use
  `LegacyInput` and a relocated ASM transformer.
- Setup accepts `minecraftHooks:false` for the optional 26.3 game hooks. SDL
  control and JVM diagnostics remain available.
- Capability presence and validation are distinct. Tests cover selected environments;
  Fabric/NeoForge launchers and rendering replacements still require their own runs.

## Building and testing

The initial validation ran on Windows with Java 25, LWJGL 3.4.3, Gradle 9.6 and
vanilla Minecraft 26.3 using OpenGL. It includes a real hidden client screenshot
and input delivery, native SDL controls/diagnostics, the Gradle launch path, and a
fresh npm-package MCP installation. World gameplay and the full mod-loader/rendering
matrix have not been validated yet.

```sh
npm ci
npm run build
# JAVA_HOME must point to JDK 25 or later:
npm run build:agent
npm test
```

The optional agent build is separate so source-analysis-only development and Docker
builds retain their existing Java requirements. The npm release workflow builds and
ships the agent. `npm run test:runtime:native` exercises an actual hidden SDL window;
set `JAVA_HOME` and `MODLENS_SDL_CLASSPATH` to LWJGL 3.4.3 core/SDL Java and native
JARs for your platform. It checks input delivery, polling consistency, hardware-like
event suppression, key expiry, Unicode text, diagnostics and uncaught exceptions.

`node scripts/test-runtime-minecraft.mjs` validates an isolated hidden vanilla 26.3
demo client without reading accounts or worlds. Set `JAVA_HOME`,
`MODLENS_TEST_MC_MANIFEST`, `MODLENS_TEST_MC_CLIENT`, `MODLENS_TEST_MC_ASSETS`,
`MODLENS_TEST_MC_ASSET_INDEX` and `MODLENS_TEST_MAVEN_CACHE`. It uses supplied cached
artifacts and downloads missing libraries with manifest checksum verification.
Evidence is retained in the printed temporary directory. The test includes the
required `-XX:StackShadowPages=32` setting and checks a Minecraft allocation report
alongside screenshots and input. Use `--baseline` to compare startup without the
agent while retaining the required client JVM options; this baseline can show a
normal game window.

`node scripts/test-runtime-remote.mjs` tests an isolated HTTP MCP server returning
plans which local CLI processes execute against a real instrumented SDL JVM. It
checks setup, session persistence, input, allocation reports, crash events, helper
restart/reconnection, and shutdown without creating a local source database. Set the same JDK/SDL variables
as the native test. Add `--helper` to the Minecraft or Gradle tests to exercise
their complete workflows through the CLI companion too.

`node scripts/test-runtime-gradle.mjs` tests the generated launch path in a
disposable JavaExec project, including paths with spaces and exclusion of unrelated
tasks. Set `JAVA_HOME` and `MODLENS_TEST_GRADLE_HOME` (Gradle 9.6). This tests the
Gradle integration; it does not replace mod-loader-specific client tests.
