package io.modlens.runtime;

import java.nio.file.Files;
import java.nio.file.Paths;
import org.lwjgl.input.Keyboard;
import org.lwjgl.input.Mouse;

/** Exercises transformed production LWJGL2 classes without opening a game window. */
public final class RealLwjgl2Smoke {
    public static void main(String[] args) throws Exception {
        Class.forName("org.lwjgl.opengl.Display", false, RealLwjgl2Smoke.class.getClassLoader());
        java.lang.reflect.Method frame = Class.forName("io.modlens.runtime.legacy.LegacyHooks").getMethod("frame", String.class);
        while (!Files.exists(Paths.get(args[0], "finish"))) {
            frame.invoke(null, "lwjgl2");
            while (Keyboard.next()) System.out.println("KEY " + Keyboard.getEventKey() + " " + Keyboard.getEventKeyState());
            while (Mouse.next()) System.out.println("MOUSE " + Mouse.getEventButton() + " " + Mouse.getEventDWheel());
            Thread.sleep(25);
        }
    }
}
