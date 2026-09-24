package org.lwjgl.glfw;

import java.nio.IntBuffer;

public final class GLFW {
    private static GLFWKeyCallbackI key;
    private static GLFWMouseButtonCallbackI button;
    private static GLFWCursorPosCallbackI cursor;
    private static GLFWScrollCallbackI scroll;
    private static GLFWCharCallbackI character;
    private static boolean visible = true;

    public static long glfwCreateWindow(int width, int height, CharSequence title, long monitor, long share) { return 123L; }
    public static void glfwPollEvents() { if (key != null) key.invoke(123L, 87, 0, 1, 0); }
    public static GLFWKeyCallback glfwSetKeyCallback(long window, GLFWKeyCallbackI callback) {
        GLFWKeyCallback old = key instanceof GLFWKeyCallback ? (GLFWKeyCallback) key : null; key = callback; return old;
    }
    public static GLFWMouseButtonCallback glfwSetMouseButtonCallback(long window, GLFWMouseButtonCallbackI callback) {
        GLFWMouseButtonCallback old = button instanceof GLFWMouseButtonCallback ? (GLFWMouseButtonCallback) button : null; button = callback; return old;
    }
    public static GLFWCursorPosCallback glfwSetCursorPosCallback(long window, GLFWCursorPosCallbackI callback) {
        GLFWCursorPosCallback old = cursor instanceof GLFWCursorPosCallback ? (GLFWCursorPosCallback) cursor : null; cursor = callback; return old;
    }
    public static GLFWScrollCallback glfwSetScrollCallback(long window, GLFWScrollCallbackI callback) {
        GLFWScrollCallback old = scroll instanceof GLFWScrollCallback ? (GLFWScrollCallback) scroll : null; scroll = callback; return old;
    }
    public static GLFWCharCallback glfwSetCharCallback(long window, GLFWCharCallbackI callback) {
        GLFWCharCallback old = character instanceof GLFWCharCallback ? (GLFWCharCallback) character : null; character = callback; return old;
    }
    public static void glfwShowWindow(long window) { visible = true; }
    public static void glfwHideWindow(long window) { visible = false; }
    public static boolean isVisible() { return visible; }
    public static void glfwFocusWindow(long window) { }
    public static int glfwGetKey(long window, int key) { return 0; }
    public static int glfwGetMouseButton(long window, int button) { return 0; }
    public static void glfwGetFramebufferSize(long window, IntBuffer width, IntBuffer height) { width.put(0, 4); height.put(0, 4); }
}
