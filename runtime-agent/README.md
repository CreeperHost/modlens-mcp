# ModLens runtime agent (Minecraft 26.3 / Java 25)

Optional development instrumentation. The agent is not a mod and is never added to a
production mod JAR. `runtime.setup` in the local MCP prepares a project, including an
IntelliJ Gradle run configuration. See [RUNTIME.md](../RUNTIME.md) for use and limitations.

Build: `npm run build:agent` with `JAVA_HOME` pointing to JDK 25 or later. No Maven,
Gradle, downloaded Java dependencies, native agent, or desktop-control service is needed.

The small bootstrap bridge contains only JDK types. The transformer uses the JDK
Class-File API. Minecraft hooks are exact descriptor matches in a single adapter;
LWJGL SDL3 supplies the input/window fallback. Never make an optional hook a requirement
for JVM telemetry. Probe capabilities, and report missing hooks instead of silently
claiming success. Validate new game versions before extending the supported range.
