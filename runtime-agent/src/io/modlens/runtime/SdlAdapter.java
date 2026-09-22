package io.modlens.runtime;

import io.modlens.runtime.bridge.Hooks;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Consumer;

/** Input is injected into SDL's event consumer; no OS input synthesis or window focus. */
final class SdlAdapter implements Hooks.Handler {

    private final RuntimeAgent agent;
    final boolean minecraftHooks;
    private final ThreadLocal<Boolean> bypass = ThreadLocal.withInitial(() -> false);
    private volatile String mode;
    private volatile long window, ticks, lastFrame;
    private volatile boolean ready;
    private final Minecraft263 minecraft;
    private Class<?> video, eventsClass, keyboardClass;
    private final ByteBuffer keys = ByteBuffer.allocateDirect(512);
    private final Map<Integer, Long> keyExpiry = new HashMap<>(),
        mouseExpiry = new HashMap<>();
    private final ArrayDeque<Consumer<Object>> synthetic = new ArrayDeque<>();
    private int windowId, buttons;
    private float x, y, relativeX, relativeY;
    private ByteBuffer textStorage;
    private boolean leaseExpired;
    private long lastPollError;

    SdlAdapter(RuntimeAgent agent, String mode, boolean hooks) {
        this.agent = agent;
        this.mode = mode;
        this.minecraftHooks = hooks;
        this.minecraft = new Minecraft263(agent);
    }

    @Override
    public boolean controlled() {
        return !bypass.get() && !mode.equals("interactive");
    }

    @Override
    public boolean hidden() {
        return !bypass.get() && mode.equals("hidden");
    }

    @Override
    public long flags(long flags) {
        return controlled() ? (flags | 0x200L | 0x400L) & ~(0x8L | 0x40L | 0x4L) : flags;
    }

    @Override
    public ByteBuffer keyboard() {
        return keys;
    }

    @Override
    public short modifiers() {
        int mod = 0;
        int[] codes = { 225, 229, 224, 228, 226, 230, 227, 231 };
        int[] masks = { 1, 2, 64, 128, 256, 512, 1024, 2048 };
        for (int i = 0; i < codes.length; i++) if (keys.get(codes[i]) != 0) mod |= masks[i];
        return (short) mod;
    }

    @Override
    public int mouse(Object px, Object py, boolean relative) {
        if (px instanceof FloatBuffer b) b.put(b.position(), relative ? relativeX : x);
        if (py instanceof FloatBuffer b) b.put(b.position(), relative ? relativeY : y);
        if (relative) {
            relativeX = 0;
            relativeY = 0;
        }
        return buttons;
    }

    @Override
    public void created(long handle, Class<?> type) {
        if (handle == 0) return;
        try {
            video = type;
            window = handle;
            windowId = (Integer) Reflect.call(video, "SDL_GetWindowID", handle);
            eventsClass = Class.forName("org.lwjgl.sdl.SDLEvents", false, type.getClassLoader());
            keyboardClass = Class.forName("org.lwjgl.sdl.SDLKeyboard", false, type.getClassLoader());
            if (!mode.equals("interactive")) applyMode(mode);
        } catch (Exception e) {
            agent.event("window_adapter_error", Map.of("reason", e.toString()));
        }
    }

    @Override
    public int poll(Object event) {
        if (bypass.get() || event == null) return -1;
        try {
            if (eventsClass == null) eventsClass = Class.forName(
                "org.lwjgl.sdl.SDLEvents",
                false,
                event.getClass().getClassLoader()
            );
            ready = true;
            pump();
            if (!synthetic.isEmpty()) {
                Reflect.call(event, "clear");
                synthetic.removeFirst().accept(event);
                return 1;
            }
            if (!controlled()) return -1;
            bypass.set(true);
            for (int i = 0; i < 256; i++) {
                boolean present = (Boolean) Reflect.call(eventsClass, "SDL_PollEvent", event);
                if (!present) return 0;
                int type = (Integer) Reflect.call(event, "type");
                // Filter hardware input, focus and occlusion changes. Keep resize, quit,
                // device and lifecycle events so native window management still works.
                if (
                    (type >= 0x300 && type < 0x500) ||
                    Set.of(513, 514, 521, 524, 525, 526, 527, 537).contains(type)
                ) continue;
                return 1;
            }
            return 0;
        } catch (Throwable e) {
            long now = System.currentTimeMillis();
            if (now - lastPollError > 5000) {
                lastPollError = now;
                agent.event("input_adapter_error", Map.of("reason", e.toString()));
            }
            return mode.equals("interactive") ? -1 : 0; // Never leak physical input in watch-only mode.
        } finally {
            bypass.set(false);
        }
    }

    private void pump() throws Exception {
        long now = System.currentTimeMillis();
        if (now - agent.lastConnected > 5000 && !leaseExpired) {
            releaseAll();
            leaseExpired = true;
            agent.event("control_lease_expired", Map.of("released", true));
        }
        if (now - agent.lastConnected <= 5000) leaseExpired = false;
        for (int k : new ArrayList<>(keyExpiry.keySet())) if (keyExpiry.get(k) <= now) key(k, false, 0, null);
        for (int b : new ArrayList<>(mouseExpiry.keySet()))
            if (mouseExpiry.get(b) <= now) button(b, false, 0, null);
        Properties c;
        while ((c = agent.commands.poll()) != null) {
            try {
                if (Long.parseLong(c.getProperty("deadline")) < now) throw new IllegalStateException(
                    "Command expired before the client could execute it"
                );
                execute(c);
            } catch (Exception e) {
                agent.complete(c, false, Map.of("error", e.toString()));
            }
        }
    }

    private void execute(Properties c) throws Exception {
        String type = c.getProperty("type");
        if (type.equals("mode")) {
            applyMode(c.getProperty("mode"));
            agent.complete(c, true, Map.of("mode", mode));
            return;
        }
        if (type.equals("screenshot")) {
            minecraft.screenshot(c);
            return;
        }
        if (type.equals("release_all")) {
            releaseAll();
            agent.complete(c, true, Map.of("released", true));
            return;
        }
        if (!controlled()) throw new IllegalStateException(
            "Client is in interactive mode. Switch to observe or hidden before MCP input."
        );
        if (window == 0) throw new IllegalStateException("Client window not ready");
        if (synthetic.size() > 128) throw new IllegalStateException("Input queue full");
        agent.event("input_action", Map.of("type", type, "commandId", c.getProperty("id"), "tick", ticks));
        switch (type) {
            case "key" -> key(
                scancode(c.getProperty("key")),
                Boolean.parseBoolean(c.getProperty("down")),
                Long.parseLong(c.getProperty("holdMs", "250")),
                c
            );
            case "mouse_button" -> button(
                Integer.parseInt(c.getProperty("button")),
                Boolean.parseBoolean(c.getProperty("down")),
                Long.parseLong(c.getProperty("holdMs", "100")),
                c
            );
            case "mouse_move" -> {
                float nx = Float.parseFloat(c.getProperty("x")),
                    ny = Float.parseFloat(c.getProperty("y"));
                boolean relative = Boolean.parseBoolean(c.getProperty("relative"));
                queue(c, e -> {
                    float dx = relative ? nx : nx - x,
                        dy = relative ? ny : ny - y;
                    x = relative ? x + nx : nx;
                    y = relative ? y + ny : ny;
                    relativeX += dx;
                    relativeY += dy;
                    Object m = part(e, "motion", 0x400);
                    set(m, "state", buttons);
                    set(m, "x", x);
                    set(m, "y", y);
                    set(m, "xrel", dx);
                    set(m, "yrel", dy);
                });
            }
            case "scroll" -> queue(c, e -> {
                Object wheel = part(e, "wheel", 0x403);
                set(wheel, "x", Float.parseFloat(c.getProperty("x", "0")));
                set(wheel, "y", Float.parseFloat(c.getProperty("y")));
            });
            case "text" -> queue(c, e -> {
                byte[] utf8 = (c.getProperty("text") + '\0').getBytes(StandardCharsets.UTF_8);
                textStorage = ByteBuffer.allocateDirect(utf8.length);
                textStorage.put(utf8).flip();
                Object text = part(e, "text", 0x303);
                set(text, "text", textStorage);
            });
            default -> throw new IllegalArgumentException("Unsupported command: " + type);
        }
    }

    private void queue(Properties command, Consumer<Object> writer) {
        synthetic.add(e -> {
            try {
                writer.accept(e);
                if (command != null) agent.complete(
                    command,
                    true,
                    Map.of("state", "event_delivered", "tick", ticks)
                );
            } catch (Throwable error) {
                if (command != null) agent.complete(command, false, Map.of("error", error.toString()));
                else agent.event("input_release_error", Map.of("reason", error.toString()));
            }
        });
    }

    private Object part(Object event, String name, int type) {
        try {
            Object p = Reflect.call(event, name);
            set(p, "type", type);
            set(p, "windowID", windowId);
            set(p, "timestamp", System.nanoTime());
            return p;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static void set(Object target, String name, Object value) {
        try {
            Reflect.call(target, name, value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void key(int key, boolean down, long hold, Properties c) {
        if (key < 1 || key >= 512) throw new IllegalArgumentException("Invalid SDL scancode");
        if (down) keyExpiry.put(key, System.currentTimeMillis() + Math.min(10000, hold));
        else keyExpiry.remove(key);
        queue(c, e -> {
            keys.put(key, (byte) (down ? 1 : 0));
            Object k = part(e, "key", down ? 0x300 : 0x301);
            set(k, "scancode", key);
            set(k, "mod", modifiers());
            set(k, "down", down);
            set(k, "repeat", false);
            try {
                set(k, "key", Reflect.call(keyboardClass, "SDL_GetKeyFromScancode", key, modifiers(), false));
            } catch (Exception ex) {
                throw new IllegalStateException(ex);
            }
        });
    }

    private void button(int button, boolean down, long hold, Properties c) {
        if (button < 1 || button > 8) throw new IllegalArgumentException("Invalid mouse button");
        if (down) mouseExpiry.put(button, System.currentTimeMillis() + Math.min(10000, hold));
        else mouseExpiry.remove(button);
        queue(c, e -> {
            if (down) buttons |= 1 << (button - 1);
            else buttons &= ~(1 << (button - 1));
            Object b = part(e, "button", down ? 0x401 : 0x402);
            set(b, "button", (byte) button);
            set(b, "down", down);
            set(b, "clicks", (byte) 1);
            set(b, "x", x);
            set(b, "y", y);
        });
    }

    private void releaseAll() {
        // Discard unconsumed presses before synthesizing releases for already-delivered state.
        synthetic.clear();
        keyExpiry.clear();
        mouseExpiry.clear();
        relativeX = 0;
        relativeY = 0;
        for (int k = 1; k < 512; k++) if (keys.get(k) != 0) key(k, false, 0, null);
        for (int b = 1; b <= 8; b++) if ((buttons & (1 << (b - 1))) != 0) button(b, false, 0, null);
    }

    private void applyMode(String next) throws Exception {
        if (!Set.of("interactive", "observe", "hidden").contains(next)) throw new IllegalArgumentException(
            "Unknown mode"
        );
        if (window == 0) throw new IllegalStateException("Window not ready");
        releaseAll();
        mode = next;
        bypass.set(true);
        try {
            Class<?> mouse = Class.forName("org.lwjgl.sdl.SDLMouse", false, video.getClassLoader());
            Reflect.call(mouse, "SDL_SetWindowRelativeMouseMode", window, false);
            Reflect.call(video, "SDL_SetWindowMouseGrab", window, false);
            Reflect.call(video, "SDL_SetWindowKeyboardGrab", window, false);
            if (!next.equals("interactive")) Reflect.call(video, "SDL_SetWindowFullscreen", window, false);
            Reflect.call(video, next.equals("hidden") ? "SDL_HideWindow" : "SDL_ShowWindow", window);
        } finally {
            bypass.set(false);
        }
        if (!next.equals("interactive")) queue(null, e -> part(e, "window", 526));
        agent.event("mode_changed", Map.of("mode", next));
    }

    @Override
    public void client(Object instance, boolean tick) {
        if (tick) {
            ticks++;
            return;
        }
        lastFrame = System.currentTimeMillis();
        minecraft.observe(instance);
    }

    @Override
    public void crash(Object report) {
        minecraft.crash(report);
    }

    Map<String, Object> capabilities(boolean jfr) {
        return Map.of(
            "inputBackend",
            ready ? "lwjgl-sdl3" : "pending",
            "window",
            window != 0,
            "minecraftHooks",
            minecraft.client != null,
            "screenshot",
            minecraft.screenshotCapability,
            "jfr",
            jfr,
            "target",
            "26.3"
        );
    }

    Map<String, Object> state() {
        return Map.of(
            "mode",
            mode,
            "tick",
            ticks,
            "lastFrame",
            lastFrame,
            "observation",
            minecraft.observation
        );
    }

    static int scancode(String key) {
        String k = key.toUpperCase(Locale.ROOT);
        if (k.matches("[A-Z]")) return k.charAt(0) - 'A' + 4;
        if (k.matches("[1-9]")) return k.charAt(0) - '1' + 30;
        if (k.equals("0")) return 39;
        if (k.matches("F([1-9]|1[0-2])")) return 57 + Integer.parseInt(k.substring(1));
        return switch (k) {
            case "ENTER", "RETURN" -> 40;
            case "ESC", "ESCAPE" -> 41;
            case "BACKSPACE" -> 42;
            case "TAB" -> 43;
            case "SPACE" -> 44;
            case "RIGHT" -> 79;
            case "LEFT" -> 80;
            case "DOWN" -> 81;
            case "UP" -> 82;
            case "LCTRL", "LCONTROL" -> 224;
            case "LSHIFT" -> 225;
            case "LALT" -> 226;
            case "RCTRL", "RCONTROL" -> 228;
            case "RSHIFT" -> 229;
            case "RALT" -> 230;
            default -> Integer.parseInt(k);
        };
    }
}
