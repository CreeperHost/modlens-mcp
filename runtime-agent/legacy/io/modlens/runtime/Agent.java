package io.modlens.runtime;

import io.modlens.runtime.legacy.LegacyAgent;
import java.io.InputStream;
import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Properties;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;

/** Single Java 8 entry point; the SDL implementation is loaded only on a matching JVM. */
public final class Agent {
    public static void premain(String config, Instrumentation instrumentation) {
        try {
            Properties properties = new Properties();
            InputStream input = Files.newInputStream(Paths.get(config));
            try { properties.load(input); } finally { input.close(); }
            String version = properties.getProperty("mcVersion", "auto");
            String classpath = System.getProperty("java.class.path", "").toLowerCase(java.util.Locale.ROOT);
            boolean sdl = ClassLoader.getSystemResource("org/lwjgl/sdl/SDLEvents.class") != null
                || classpath.contains("lwjgl-sdl");
            int javaVersion = javaVersion();
            if (javaVersion >= 25 && sdl && ("26.3".equals(version) || "auto".equals(version))) {
                try {
                    Class<?> modern = Class.forName("io.modlens.runtime.Agent25", true, Agent.class.getClassLoader());
                    modern.getMethod("premain", String.class, Instrumentation.class).invoke(null, config, instrumentation);
                    return;
                } catch (Throwable unavailable) {
                    System.err.println("[ModLens] SDL adapter unavailable, using JVM monitoring: " + unavailable);
                }
            }
            java.nio.file.Path bootstrap = Files.createTempFile("modlens-legacy-hooks-", ".jar");
            bootstrap.toFile().deleteOnExit();
            JarOutputStream out = new JarOutputStream(Files.newOutputStream(bootstrap));
            try {
                for (String name : new String[] { "LegacyHooks", "LegacyHooks$Handler" }) {
                    String entry = "io/modlens/runtime/legacy/" + name + ".class";
                    out.putNextEntry(new JarEntry(entry));
                    InputStream resource = Agent.class.getResourceAsStream("/" + entry);
                    if (resource == null) throw new IllegalStateException("Missing " + entry);
                    try {
                        byte[] bytes = new byte[8192];
                        int count;
                        while ((count = resource.read(bytes)) != -1) out.write(bytes, 0, count);
                    } finally { resource.close(); }
                    out.closeEntry();
                }
            } finally { out.close(); }
            instrumentation.appendToBootstrapClassLoaderSearch(new JarFile(bootstrap.toFile()));
            LegacyAgent.start(config, instrumentation);
        } catch (Throwable failure) {
            System.err.println("[ModLens] Agent disabled: " + failure);
        }
    }

    private static int javaVersion() {
        String version = System.getProperty("java.specification.version", "8");
        try { return Integer.parseInt(version.startsWith("1.") ? version.substring(2) : version); }
        catch (NumberFormatException ignored) { return 8; }
    }
}
