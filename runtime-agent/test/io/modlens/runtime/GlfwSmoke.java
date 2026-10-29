package io.modlens.runtime;

import java.nio.file.Files;
import java.nio.file.Paths;
import org.lwjgl.glfw.*;

public final class GlfwSmoke {
    public static void main(String[] args) throws Exception {
        // Mirror Knot's isolated-parent lookup: a visible parent resource is
        // rejected, while a resource-less class is delegated to the platform loader.
        final String hook = "io.modlens.runtime.legacy.LegacyHooks";
        ClassLoader isolated = new ClassLoader(null) {
            protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
                if (!name.equals(hook)) return super.loadClass(name, resolve);
                if (ClassLoader.getSystemResource(name.replace('.', '/') + ".class") != null)
                    throw new ClassNotFoundException("Restricted parent resource: " + name);
                return ClassLoader.getPlatformClassLoader().loadClass(name);
            }
        };
        Class<?> bridge = isolated.loadClass(hook);
        if (bridge.getClassLoader() != null || bridge.getField("handler").get(null) == null)
            throw new AssertionError("Bridge must resolve to the active bootstrap instance");
        long window = GLFW.glfwCreateWindow(4, 4, "test", 0, 0);
        GLFW.glfwSetKeyCallback(window, (w, key, scan, action, mods) -> System.out.println("KEY " + key + " " + action));
        GLFW.glfwSetMouseButtonCallback(window, (w, button, action, mods) -> System.out.println("BUTTON " + button + " " + action));
        GLFW.glfwSetCursorPosCallback(window, (w, x, y) -> System.out.println("MOVE " + x + " " + y));
        GLFW.glfwSetScrollCallback(window, (w, x, y) -> System.out.println("SCROLL " + x + " " + y));
        GLFW.glfwSetCharCallback(window, (w, codepoint) -> System.out.println("CHAR " + codepoint));
        GLFW.glfwShowWindow(window);
        while (!Files.exists(Paths.get(args[0], "finish"))) {
            GLFW.glfwPollEvents();
            Thread.sleep(25);
        }
    }
}
