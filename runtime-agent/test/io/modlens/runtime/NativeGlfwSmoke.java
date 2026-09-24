package io.modlens.runtime;

import java.nio.file.Files;
import java.nio.file.Paths;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.opengl.GL;
import org.lwjgl.opengl.GL11;

public final class NativeGlfwSmoke {
    public static void main(String[] args) throws Exception {
        if (!GLFW.glfwInit()) throw new IllegalStateException("GLFW initialization failed");
        long window = GLFW.glfwCreateWindow(64, 64, "ModLens GLFW smoke", 0, 0);
        if (window == 0) throw new IllegalStateException("GLFW window creation failed");
        GLFW.glfwMakeContextCurrent(window);
        GL.createCapabilities();
        GLFW.glfwSetKeyCallback(window, (w, key, scan, action, mods) -> System.out.println("KEY " + key + " " + action));
        GLFW.glfwSetMouseButtonCallback(window, (w, button, action, mods) -> System.out.println("BUTTON " + button + " " + action));
        GLFW.glfwSetCursorPosCallback(window, (w, x, y) -> System.out.println("MOVE " + x + " " + y));
        GLFW.glfwSetScrollCallback(window, (w, x, y) -> System.out.println("SCROLL " + x + " " + y));
        GLFW.glfwSetCharCallback(window, (w, codepoint) -> System.out.println("CHAR " + codepoint));
        GLFW.glfwShowWindow(window);
        if (GLFW.glfwGetWindowAttrib(window, GLFW.GLFW_VISIBLE) != 0)
            throw new AssertionError("Hidden runtime window became visible");
        while (!Files.exists(Paths.get(args[0], "finish"))) {
            GL11.glClearColor(1, 0, 0, 1);
            GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
            GLFW.glfwPollEvents();
            GLFW.glfwSwapBuffers(window);
            Thread.sleep(25);
        }
        GLFW.glfwDestroyWindow(window);
        GLFW.glfwTerminate();
    }
}
