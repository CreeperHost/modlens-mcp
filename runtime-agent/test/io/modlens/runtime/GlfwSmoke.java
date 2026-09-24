package io.modlens.runtime;

import java.nio.file.Files;
import java.nio.file.Paths;
import org.lwjgl.glfw.*;

public final class GlfwSmoke {
    public static void main(String[] args) throws Exception {
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
