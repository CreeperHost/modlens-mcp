package org.lwjgl.glfw;
public final class GLFWScrollCallback implements GLFWScrollCallbackI {
    private final GLFWScrollCallbackI delegate;
    private GLFWScrollCallback(GLFWScrollCallbackI delegate) { this.delegate = delegate; }
    public static GLFWScrollCallback create(GLFWScrollCallbackI delegate) { return new GLFWScrollCallback(delegate); }
    public void invoke(long window, double x, double y) { delegate.invoke(window, x, y); }
}
