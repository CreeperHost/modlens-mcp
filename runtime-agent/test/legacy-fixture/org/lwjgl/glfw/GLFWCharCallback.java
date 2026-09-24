package org.lwjgl.glfw;
public final class GLFWCharCallback implements GLFWCharCallbackI {
    private final GLFWCharCallbackI delegate;
    private GLFWCharCallback(GLFWCharCallbackI delegate) { this.delegate = delegate; }
    public static GLFWCharCallback create(GLFWCharCallbackI delegate) { return new GLFWCharCallback(delegate); }
    public void invoke(long window, int codepoint) { delegate.invoke(window, codepoint); }
}
