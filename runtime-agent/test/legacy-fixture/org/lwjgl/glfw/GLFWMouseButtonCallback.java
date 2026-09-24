package org.lwjgl.glfw;
public final class GLFWMouseButtonCallback implements GLFWMouseButtonCallbackI {
    private final GLFWMouseButtonCallbackI delegate;
    private GLFWMouseButtonCallback(GLFWMouseButtonCallbackI delegate) { this.delegate = delegate; }
    public static GLFWMouseButtonCallback create(GLFWMouseButtonCallbackI delegate) { return new GLFWMouseButtonCallback(delegate); }
    public void invoke(long window, int button, int action, int mods) { delegate.invoke(window, button, action, mods); }
}
