package io.modlens.runtime;

import java.nio.file.Files;
import java.nio.file.Paths;
import org.lwjgl.opengl.Display;
import org.lwjgl.input.Keyboard;
import org.lwjgl.input.Mouse;
import net.minecraft.CrashReport;

public final class LegacySmoke {
    public static void main(String[] args) throws Exception {
        Display.create();
        new CrashReport(new IllegalStateException("fixture"));
        while (!Files.exists(Paths.get(args[0], "finish"))) {
            Display.update();
            while (Keyboard.next()) System.out.println("KEY " + Keyboard.getEventKey() + " " + Keyboard.getEventKeyState());
            while (Mouse.next()) System.out.println("MOUSE " + Mouse.getEventButton() + " " + Mouse.getEventDWheel());
            Thread.sleep(25);
        }
    }
}
