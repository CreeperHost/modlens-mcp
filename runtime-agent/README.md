# ModLens runtime agent

Optional development instrumentation. The agent is not a mod and is never added to a
production mod JAR. `runtime.setup` in the local MCP prepares a project, including an
IntelliJ Gradle run configuration. See [RUNTIME.md](../RUNTIME.md) for use and limitations.

Build: `npm run build:agent` with `JAVA_HOME` pointing to JDK 25 or later and
`MODLENS_LEGACY_JAVA_HOME` pointing to JDK 17. The packaged JAR has a Java 8
entry point, a Java 11 JFR module, and a Java 25 SDL adapter. It includes a
relocated ASM 9.9.1 copy for GLFW and LWJGL2 hooks; see
`vendor/ASM-LICENSE.txt`. No native agent or desktop-control service is needed.

The bootstrap bridges contain only JDK types. The 26.3 transformer uses the JDK
Class-File API; the older paths use relocated ASM. Inspect connected capabilities
for the active input backend, screenshot, and JFR support.
