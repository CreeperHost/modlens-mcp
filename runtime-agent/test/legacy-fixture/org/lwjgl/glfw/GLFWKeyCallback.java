package org.lwjgl.glfw;
public final class GLFWKeyCallback implements GLFWKeyCallbackI {
    private final GLFWKeyCallbackI delegate;
    private GLFWKeyCallback(GLFWKeyCallbackI delegate) { this.delegate = delegate; }
    public static GLFWKeyCallback create(GLFWKeyCallbackI delegate) { return new GLFWKeyCallback(delegate); }
    public void invoke(long window, int key, int scancode, int action, int mods) { delegate.invoke(window, key, scancode, action, mods); }
}
