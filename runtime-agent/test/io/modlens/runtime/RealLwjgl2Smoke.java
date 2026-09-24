package io.modlens.runtime;

import io.modlens.runtime.legacy.LegacyHooks;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.lwjgl.input.Keyboard;
import org.lwjgl.input.Mouse;

/** Exercises transformed production LWJGL2 classes without opening a game window. */
public final class RealLwjgl2Smoke {
    public static void main(String[] args) throws Exception {
        Class.forName("org.lwjgl.opengl.Display", false, RealLwjgl2Smoke.class.getClassLoader());
        while (!Files.exists(Paths.get(args[0], "finish"))) {
            LegacyHooks.frame("lwjgl2");
            while (Keyboard.next()) System.out.println("KEY " + Keyboard.getEventKey() + " " + Keyboard.getEventKeyState());
            while (Mouse.next()) System.out.println("MOUSE " + Mouse.getEventButton() + " " + Mouse.getEventDWheel());
            Thread.sleep(25);
        }
    }
}
