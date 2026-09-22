package io.modlens.runtime;

import java.nio.*;
import java.nio.file.*;

/** Real SDL window/event loop, with no desktop input or Minecraft assets needed. */
public class NativeSmoke {

    private static volatile byte[] allocationSink;

    private static void allocateFixture() {
        // Deliberate short-lived allocations; volatile publication prevents elimination.
        for (int i = 0; i < 4096; i++) allocationSink = new byte[32768];
        allocationSink = null;
    }

    public static void main(String[] args) throws Exception {
        allocateFixture();
        System.setOut(new java.io.PrintStream(System.out, true, java.nio.charset.StandardCharsets.UTF_8));
        Class<?> init = Class.forName("org.lwjgl.sdl.SDLInit"),
            video = Class.forName("org.lwjgl.sdl.SDLVideo"),
            events = Class.forName("org.lwjgl.sdl.SDLEvents"),
            eventType = Class.forName("org.lwjgl.sdl.SDL_Event");
        if (!((Boolean) Reflect.call(init, "SDL_Init", 0x20))) throw new IllegalStateException(
            "SDL_Init failed"
        );
        long window = (Long) Reflect.call(video, "SDL_CreateWindow", "ModLens automated test", 640, 360, 8L);
        if (window == 0) throw new IllegalStateException("Window creation failed");
        Object event = Reflect.call(eventType, "calloc");
        // A hardware-like queued key event must be discarded in watch-only mode.
        Object physical = Reflect.call(event, "key");
        Reflect.call(physical, "type", 0x300);
        Reflect.call(physical, "scancode", 4);
        Reflect.call(physical, "down", true);
        Reflect.call(events, "SDL_PushEvent", event);
        long end = System.currentTimeMillis() + 25_000;
        boolean sawKey = false;
        while (System.currentTimeMillis() < end) {
            while ((Boolean) Reflect.call(events, "SDL_PollEvent", event)) {
                int type = (Integer) Reflect.call(event, "type");
                if (type == 0x300) {
                    Object key = Reflect.call(event, "key");
                    int scan = (Integer) Reflect.call(key, "scancode");
                    if (scan == 26) {
                        sawKey = true;
                        ByteBuffer state = (ByteBuffer) Reflect.call(
                            Class.forName("org.lwjgl.sdl.SDLKeyboard"),
                            "SDL_GetKeyboardState"
                        );
                        if (state.get(26) != 1) throw new AssertionError("Polling disagrees with key event");
                    }
                    if (scan == 4) throw new AssertionError("Physical input leaked through observe mode");
                    System.out.println("KEY " + scan);
                }
                if (type == 0x301) System.out.println("RELEASE");
                if (type == 0x303) System.out.println(
                    "TEXT " + Reflect.call(Reflect.call(event, "text"), "textString")
                );
                if (type == 0x400) {
                    var px = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asFloatBuffer();
                    var py = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asFloatBuffer();
                    Class<?> mouse = Class.forName("org.lwjgl.sdl.SDLMouse");
                    Reflect.call(mouse, "SDL_GetRelativeMouseState", px, py);
                    if (px.get(0) != 12 || py.get(0) != -5) throw new AssertionError(
                        "Relative polling disagrees with motion event"
                    );
                    Reflect.call(mouse, "SDL_GetRelativeMouseState", px, py);
                    if (px.get(0) != 0 || py.get(0) != 0) throw new AssertionError(
                        "Relative deltas must reset after polling"
                    );
                    System.out.println("MOTION");
                }
                if (type == 0x401) System.out.println("BUTTON");
                if (type == 0x403) System.out.println("SCROLL");
            }
            Thread.sleep(10);
            if (sawKey && Files.exists(Path.of(args[0], "finish"))) break;
        }
        Reflect.call(event, "free");
        Reflect.call(video, "SDL_DestroyWindow", window);
        Reflect.call(init, "SDL_Quit");
        if (!sawKey) throw new AssertionError("No virtual W event reached the SDL consumer");
        Thread t = new Thread(() -> {
            throw new IllegalStateException("ModLens smoke exception");
        }, "smoke-failure");
        t.start();
        t.join();
    }
}
