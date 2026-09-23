package io.modlens.runtime;

import java.lang.instrument.Instrumentation;
import java.nio.file.*;
import java.util.jar.*;

public final class Agent {

    public static void premain(String config, Instrumentation instrumentation) {
        try {
            if (config == null || config.isBlank()) throw new IllegalArgumentException(
                "Expected an absolute connection.properties path"
            );
            Path bootstrap = Files.createTempFile("modlens-bridge-", ".jar");
            bootstrap.toFile().deleteOnExit();
            try (JarOutputStream out = new JarOutputStream(Files.newOutputStream(bootstrap))) {
                for (String name : new String[] { "Hooks", "Hooks$Handler" }) {
                    String entry = "io/modlens/runtime/bridge/" + name + ".class";
                    out.putNextEntry(new JarEntry(entry));
                    try (var in = Agent.class.getResourceAsStream("/" + entry)) {
                        in.transferTo(out);
                    }
                    out.closeEntry();
                }
            }
            instrumentation.appendToBootstrapClassLoaderSearch(new JarFile(bootstrap.toFile()));
            RuntimeAgent.start(Path.of(config), instrumentation);
        } catch (Throwable failure) {
            // An optional diagnostic agent must not prevent a dev client from starting.
            System.err.println("[ModLens] Agent disabled: " + failure);
        }
    }
}
