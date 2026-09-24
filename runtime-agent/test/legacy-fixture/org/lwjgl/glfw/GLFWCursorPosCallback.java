package org.lwjgl.glfw;
public final class GLFWCursorPosCallback implements GLFWCursorPosCallbackI {
    private final GLFWCursorPosCallbackI delegate;
    private GLFWCursorPosCallback(GLFWCursorPosCallbackI delegate) { this.delegate = delegate; }
    public static GLFWCursorPosCallback create(GLFWCursorPosCallbackI delegate) { return new GLFWCursorPosCallback(delegate); }
    public void invoke(long window, double x, double y) { delegate.invoke(window, x, y); }
}
