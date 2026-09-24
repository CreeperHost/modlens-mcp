package io.modlens.runtime.legacy;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.lang.invoke.MethodHandles;
import java.lang.reflect.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import javax.imageio.ImageIO;

/** Input is delivered through LWJGL's own event consumers on the game thread. */
final class LegacyInput implements LegacyHooks.Handler {
    private static final int NO_OVERRIDE = Integer.MIN_VALUE;
    private final LegacyAgent agent;
    private final Deque<Properties> commands = new ArrayDeque<Properties>();
    private final Deque<KeyEvent> keyboard = new ArrayDeque<KeyEvent>();
    private final Deque<MouseEvent> mouse = new ArrayDeque<MouseEvent>();
    private final Map<Integer, Long> keyExpiry = new HashMap<Integer, Long>();
    private final Map<Integer, Long> buttonExpiry = new HashMap<Integer, Long>();
    private final Map<String, Object> callbacks = new HashMap<String, Object>();
    private final Map<String, Object> wrappers = new HashMap<String, Object>();
    private volatile String mode;
    private volatile String backend = "pending";
    private volatile long window, frames, lastFrame;
    private volatile Map<String, Object> observation = Collections.emptyMap();
    private volatile ClassLoader minecraftLoader;
    private volatile String minecraftClass;
    private long lastObserved;
    private boolean leaseExpired;
    private KeyEvent currentKey;
    private MouseEvent currentMouse;
    private int x, y;
    private int deltaX, deltaY, wheelDelta;

    LegacyInput(LegacyAgent agent, String mode) { this.agent = agent; this.mode = mode; }

    static final class KeyEvent {
        final int key;
        final char character;
        final boolean down;
        final Properties command;
        KeyEvent(int key, char character, boolean down, Properties command) {
            this.key = key; this.character = character; this.down = down; this.command = command;
        }
    }

    static final class MouseEvent {
        final int button, x, y, dx, dy, wheel;
        final boolean down;
        final Properties command;
        MouseEvent(int button, int x, int y, int dx, int dy, int wheel, boolean down, Properties command) {
            this.button = button; this.x = x; this.y = y; this.dx = dx; this.dy = dy;
            this.wheel = wheel; this.down = down; this.command = command;
        }
    }

    synchronized boolean offer(Properties command) {
        if (!Arrays.asList("mode", "key", "mouse_button", "mouse_move", "scroll", "text",
                "release_all", "screenshot").contains(command.getProperty("type"))) return false;
        if (commands.size() >= 16) {
            agent.complete(command.getProperty("id"), false, LegacyAgent.map("error", "Input command queue full"));
            return true;
        }
        commands.addLast(command);
        return true;
    }

    public synchronized void frame(String nextBackend) {
        backend = nextBackend;
        frames++;
        lastFrame = System.currentTimeMillis();
        if (lastFrame - agent.lastConnected > 5000 && !leaseExpired) {
            releaseAll();
            leaseExpired = true;
            agent.event("input_lease_expired", LegacyAgent.map("mode", mode));
        }
        if (lastFrame - agent.lastConnected <= 5000) leaseExpired = false;
        releaseExpired();
        Properties command;
        while ((command = commands.pollFirst()) != null) {
            try { execute(command); }
            catch (Throwable error) { agent.complete(command.getProperty("id"), false, LegacyAgent.map("error", error.toString())); }
        }
        if (lastFrame - lastObserved >= 1000) {
            lastObserved = lastFrame;
            observe();
        }
    }

    public void created(long handle) {
        if (handle == 0) return;
        window = handle;
        if (mode.equals("hidden") && handle != 1L) {
            try { glfw("glfwHideWindow", new Class<?>[] { long.class }, handle); }
            catch (Exception error) { agent.event("window_adapter_error", LegacyAgent.map("reason", error.toString())); }
        }
    }

    void minecraftLoader(ClassLoader loader, String name) {
        minecraftLoader = loader;
        minecraftClass = name;
    }

    public boolean controlled() {
        return !mode.equals("interactive") || (backend.equals("lwjgl2") && (!keyboard.isEmpty() || !mouse.isEmpty()));
    }
    public boolean hidden() { return mode.equals("hidden"); }

    public void crash(Object report) {
        try {
            String text = String.valueOf(report);
            if (text.length() > 24000) text = text.substring(0, 24000);
            String name = "minecraft-crash-" + System.currentTimeMillis() + ".txt";
            Files.write(agent.artifacts.resolve(name), text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            agent.event("minecraft_crash", LegacyAgent.map("report", text, "artifact", name));
        } catch (Throwable error) {
            agent.event("minecraft_crash", LegacyAgent.map("reason", error.toString()));
        }
    }

    public synchronized int override(String owner, String method, int argument) {
        if (!controlled()) return NO_OVERRIDE;
        if (owner.equals("Keyboard")) {
            if (method.equals("next")) {
                currentKey = keyboard.pollFirst();
                if (currentKey != null && currentKey.command != null) delivered(currentKey.command);
                return currentKey == null ? 0 : 1;
            }
            if (method.equals("isKeyDown")) return keyExpiry.containsKey(argument) ? 1 : 0;
            if (currentKey == null) return NO_OVERRIDE;
            if (method.equals("getEventKey")) return currentKey.key;
            if (method.equals("getEventCharacter")) return currentKey.character;
            if (method.equals("getEventKeyState")) return currentKey.down ? 1 : 0;
        }
        if (owner.equals("Mouse")) {
            if (method.equals("next")) {
                currentMouse = mouse.pollFirst();
                if (currentMouse != null && currentMouse.command != null) delivered(currentMouse.command);
                return currentMouse == null ? 0 : 1;
            }
            if (method.equals("isButtonDown")) return buttonExpiry.containsKey(argument) ? 1 : 0;
            if (method.equals("getX") || method.equals("getEventX")) return method.equals("getX") ? x : currentMouse == null ? 0 : currentMouse.x;
            if (method.equals("getY") || method.equals("getEventY")) return method.equals("getY") ? y : currentMouse == null ? 0 : currentMouse.y;
            if (method.equals("getDX")) { int value = deltaX; deltaX = 0; return value; }
            if (method.equals("getDY")) { int value = deltaY; deltaY = 0; return value; }
            if (method.equals("getDWheel")) { int value = wheelDelta; wheelDelta = 0; return value; }
            if (currentMouse == null) return NO_OVERRIDE;
            if (method.equals("getEventButton")) return currentMouse.button;
            if (method.equals("getEventButtonState")) return currentMouse.down ? 1 : 0;
            if (method.equals("getEventDX")) return currentMouse.dx;
            if (method.equals("getEventDY")) return currentMouse.dy;
            if (method.equals("getEventDWheel")) return currentMouse.wheel;
        }
        if (owner.equals("GLFW")) {
            if (method.equals("glfwGetKey")) return keyExpiry.containsKey(argument) ? 1 : 0;
            if (method.equals("glfwGetMouseButton")) return buttonExpiry.containsKey(argument) ? 1 : 0;
        }
        return NO_OVERRIDE;
    }

    public synchronized Object wrapCallback(final Object callback, final String method) {
        if (callback == null) {
            callbacks.remove(method);
            wrappers.remove(method);
            return null;
        }
        try {
            String type = method.substring("glfwSet".length());
            String name = "org.lwjgl.glfw.GLFW" + type;
            ClassLoader loader = callback.getClass().getClassLoader();
            final Class<?> iface = Class.forName(name + "I", false, loader);
            Class<?> wrapperType = Class.forName(name, false, loader);
            Object proxy = Proxy.newProxyInstance(loader, new Class<?>[] { iface }, new InvocationHandler() {
                public Object invoke(Object ignored, Method invoked, Object[] args) throws Throwable {
                    if (invoked.getName().equals("invoke")) {
                        if (!controlled()) invokeCallback(callback, args);
                        return null;
                    }
                    if (invoked.getName().equals("toString")) return "ModLens " + method;
                    if (invoked.getName().equals("hashCode")) return System.identityHashCode(ignored);
                    if (invoked.getName().equals("equals")) return ignored == args[0];
                    if (invoked.isDefault()) return invokeDefault(ignored, invoked, args);
                    throw new UnsupportedOperationException(invoked.getName());
                }
            });
            Object wrapper = wrapperType.getMethod("create", iface).invoke(null, proxy);
            callbacks.put(method, callback);
            wrappers.put(method, wrapper);
            return wrapper;
        } catch (Throwable error) {
            agent.event("callback_unavailable", LegacyAgent.map("method", method,
                "reason", error.toString(), "cause", error.getCause() == null ? "" : error.getCause().toString()));
            return callback;
        }
    }

    private static void invokeCallback(Object callback, Object[] arguments) throws Exception {
        for (Class<?> type : callback.getClass().getInterfaces()) {
            for (Method method : type.getMethods()) {
                if (!method.getName().equals("invoke") || method.getParameterTypes().length != arguments.length) continue;
                method.invoke(callback, arguments);
                return;
            }
        }
        throw new NoSuchMethodException("Callback invoke");
    }

    private static Object invokeDefault(Object proxy, Method method, Object[] arguments) throws Throwable {
        try {
            Method helper = InvocationHandler.class.getMethod("invokeDefault", Object.class, Method.class, Object[].class);
            try { return helper.invoke(null, proxy, method, arguments); }
            catch (InvocationTargetException error) { throw error.getCause(); }
        } catch (NoSuchMethodException java8) {
            Constructor<MethodHandles.Lookup> constructor = MethodHandles.Lookup.class
                .getDeclaredConstructor(Class.class, int.class);
            constructor.setAccessible(true);
            Class<?> owner = method.getDeclaringClass();
            MethodHandles.Lookup lookup = constructor.newInstance(owner, 15);
            return lookup.unreflectSpecial(method, owner).bindTo(proxy)
                .invokeWithArguments(arguments == null ? new Object[0] : arguments);
        }
    }

    private void execute(Properties command) throws Exception {
        String type = command.getProperty("type");
        String id = command.getProperty("id");
        if (Long.parseLong(command.getProperty("deadline", "0")) < System.currentTimeMillis())
            throw new IllegalStateException("Command expired before the client processed it");
        if (type.equals("mode")) {
            String next = command.getProperty("mode");
            if (!Arrays.asList("interactive", "observe", "hidden").contains(next)) throw new IllegalArgumentException("Unknown mode");
            if (next.equals("hidden") && !backend.equals("glfw"))
                throw new UnsupportedOperationException("LWJGL2 cannot hide its window through the Java display API");
            releaseAll();
            mode = next;
            if (backend.equals("glfw") && window != 0)
                glfw(next.equals("hidden") ? "glfwHideWindow" : "glfwShowWindow", new Class<?>[] { long.class }, window);
            agent.complete(id, true, LegacyAgent.map("mode", mode));
            agent.event("mode_changed", LegacyAgent.map("mode", mode));
            return;
        }
        if (type.equals("release_all")) {
            releaseAll();
            agent.complete(id, true, LegacyAgent.map("released", true));
            return;
        }
        if (type.equals("screenshot")) {
            screenshot(command);
            return;
        }
        if (!controlled()) throw new IllegalStateException("Client is in interactive mode; switch to observe before MCP input");
        if (backend.equals("pending")) throw new IllegalStateException("LWJGL input is not ready");
        agent.event("input_action", LegacyAgent.map("type", type, "commandId", id, "tick", frames));
        if (type.equals("key")) {
            int key = backend.equals("glfw") ? glfwKey(command.getProperty("key")) : lwjgl2Key(command.getProperty("key"));
            boolean down = Boolean.parseBoolean(command.getProperty("down"));
            if (down) keyExpiry.put(key, System.currentTimeMillis() + Math.min(10000, Long.parseLong(command.getProperty("holdMs", "250"))));
            else keyExpiry.remove(key);
            if (backend.equals("glfw")) {
                Object callback = callbacks.get("glfwSetKeyCallback");
                if (callback == null) throw new IllegalStateException("GLFW key callback not installed");
                invokeCallback(callback, new Object[] { window, key, 0, down ? 1 : 0, 0 });
                delivered(command);
            } else keyboard.addLast(new KeyEvent(key, (char) 0, down, command));
        } else if (type.equals("text")) {
            String text = command.getProperty("text");
            if (backend.equals("glfw")) {
                Object callback = callbacks.get("glfwSetCharCallback");
                if (callback == null) throw new IllegalStateException("GLFW char callback not installed");
                for (int i = 0; i < text.length(); i += Character.charCount(text.codePointAt(i)))
                    invokeCallback(callback, new Object[] { window, text.codePointAt(i) });
                delivered(command);
            } else {
                for (int i = 0; i < text.length(); i++) keyboard.addLast(new KeyEvent(0, text.charAt(i), true,
                    i == text.length() - 1 ? command : null));
            }
        } else if (type.equals("mouse_button")) {
            int button = Integer.parseInt(command.getProperty("button"));
            if (button < 1 || button > 8) throw new IllegalArgumentException("Invalid mouse button");
            button = button == 2 ? 2 : button == 3 ? 1 : button - 1;
            boolean down = Boolean.parseBoolean(command.getProperty("down"));
            if (down) buttonExpiry.put(button, System.currentTimeMillis() + Math.min(10000, Long.parseLong(command.getProperty("holdMs", "100"))));
            else buttonExpiry.remove(button);
            if (backend.equals("glfw")) {
                Object callback = callbacks.get("glfwSetMouseButtonCallback");
                if (callback == null) throw new IllegalStateException("GLFW mouse callback not installed");
                invokeCallback(callback, new Object[] { window, button, down ? 1 : 0, 0 });
                delivered(command);
            } else mouse.addLast(new MouseEvent(button, x, y, 0, 0, 0, down, command));
        } else if (type.equals("mouse_move")) {
            int requestedX = (int) Float.parseFloat(command.getProperty("x"));
            int requestedY = (int) Float.parseFloat(command.getProperty("y"));
            boolean relative = Boolean.parseBoolean(command.getProperty("relative"));
            int nx = relative ? x + requestedX : requestedX;
            int ny = relative ? y + requestedY : requestedY;
            int dx = nx - x, dy = ny - y;
            x = nx; y = ny;
            deltaX += dx; deltaY += dy;
            if (backend.equals("glfw")) {
                Object callback = callbacks.get("glfwSetCursorPosCallback");
                if (callback == null) throw new IllegalStateException("GLFW cursor callback not installed");
                invokeCallback(callback, new Object[] { window, (double) x, (double) y });
                delivered(command);
            } else mouse.addLast(new MouseEvent(-1, x, y, dx, dy, 0, false, command));
        } else if (type.equals("scroll")) {
            int wheel = (int) (Float.parseFloat(command.getProperty("y")) * 120);
            wheelDelta += wheel;
            if (backend.equals("glfw")) {
                Object callback = callbacks.get("glfwSetScrollCallback");
                if (callback == null) throw new IllegalStateException("GLFW scroll callback not installed");
                invokeCallback(callback, new Object[] { window,
                    Double.parseDouble(command.getProperty("x", "0")), Double.parseDouble(command.getProperty("y")) });
                delivered(command);
            } else mouse.addLast(new MouseEvent(-1, x, y, 0, 0, wheel, false, command));
        } else throw new IllegalArgumentException("Unsupported input command: " + type);
    }

    private void delivered(Properties command) {
        agent.complete(command.getProperty("id"), true, LegacyAgent.map("state", "event_delivered", "tick", frames));
    }

    private void releaseExpired() {
        long now = System.currentTimeMillis();
        for (Integer key : new ArrayList<Integer>(keyExpiry.keySet())) {
            if (keyExpiry.get(key) > now) continue;
            keyExpiry.remove(key);
            try {
                if (backend.equals("glfw")) {
                    Object callback = callbacks.get("glfwSetKeyCallback");
                    if (callback != null) invokeCallback(callback, new Object[] { window, key, 0, 0, 0 });
                } else keyboard.addLast(new KeyEvent(key, (char) 0, false, null));
            } catch (Exception error) { agent.event("input_release_error", LegacyAgent.map("reason", error.toString())); }
        }
        for (Integer button : new ArrayList<Integer>(buttonExpiry.keySet())) {
            if (buttonExpiry.get(button) > now) continue;
            buttonExpiry.remove(button);
            try {
                if (backend.equals("glfw")) {
                    Object callback = callbacks.get("glfwSetMouseButtonCallback");
                    if (callback != null) invokeCallback(callback, new Object[] { window, button, 0, 0 });
                } else mouse.addLast(new MouseEvent(button, x, y, 0, 0, 0, false, null));
            } catch (Exception error) { agent.event("input_release_error", LegacyAgent.map("reason", error.toString())); }
        }
    }

    private void releaseAll() {
        keyboard.clear(); mouse.clear();
        for (Integer key : new ArrayList<Integer>(keyExpiry.keySet())) keyExpiry.put(key, 0L);
        for (Integer button : new ArrayList<Integer>(buttonExpiry.keySet())) buttonExpiry.put(button, 0L);
        releaseExpired();
    }

    private static int glfwKey(String key) {
        String value = key.toUpperCase(Locale.ROOT);
        if (value.matches("[A-Z0-9]")) return value.charAt(0);
        if (value.matches("F([1-9]|1[0-2])")) return 289 + Integer.parseInt(value.substring(1));
        if (value.equals("SPACE")) return 32;
        if (value.equals("ENTER") || value.equals("RETURN")) return 257;
        if (value.equals("ESC") || value.equals("ESCAPE")) return 256;
        if (value.equals("TAB")) return 258;
        if (value.equals("BACKSPACE")) return 259;
        if (value.equals("RIGHT")) return 262;
        if (value.equals("LEFT")) return 263;
        if (value.equals("DOWN")) return 264;
        if (value.equals("UP")) return 265;
        if (value.equals("LSHIFT")) return 340;
        if (value.equals("RSHIFT")) return 344;
        if (value.equals("LCTRL")) return 341;
        if (value.equals("RCTRL")) return 345;
        return Integer.parseInt(value);
    }

    private static int lwjgl2Key(String key) throws Exception {
        Class<?> keyboard = Class.forName("org.lwjgl.input.Keyboard");
        if (key.matches("\\d+")) return Integer.parseInt(key);
        String value = key.toUpperCase(Locale.ROOT);
        if (value.equals("ESC")) value = "ESCAPE";
        if (value.equals("ENTER")) value = "RETURN";
        int code = (Integer) keyboard.getMethod("getKeyIndex", String.class).invoke(null, value);
        if (code == 0) throw new IllegalArgumentException("Unknown LWJGL2 key: " + key);
        return code;
    }

    private static Object glfw(String method, Class<?>[] types, Object... args) throws Exception {
        return Class.forName("org.lwjgl.glfw.GLFW").getMethod(method, types).invoke(null, args);
    }

    private void screenshot(Properties command) throws Exception {
        int width, height;
        if (backend.equals("glfw")) {
            IntBuffer w = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
            IntBuffer h = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
            glfw("glfwGetFramebufferSize", new Class<?>[] { long.class, IntBuffer.class, IntBuffer.class }, window, w, h);
            width = w.get(0); height = h.get(0);
        } else {
            Class<?> display = Class.forName("org.lwjgl.opengl.Display");
            width = (Integer) display.getMethod("getWidth").invoke(null);
            height = (Integer) display.getMethod("getHeight").invoke(null);
        }
        if (width < 1 || height < 1 || (long) width * height > 16000000)
            throw new IOException("Invalid or oversized framebuffer: " + width + "x" + height);
        ByteBuffer pixels = ByteBuffer.allocateDirect(width * height * 4).order(ByteOrder.nativeOrder());
        Class<?> gl = Class.forName("org.lwjgl.opengl.GL11");
        gl.getMethod("glReadPixels", int.class, int.class, int.class, int.class, int.class, int.class, ByteBuffer.class)
            .invoke(null, 0, 0, width, height, 0x1908, 0x1401, pixels);
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int row = 0; row < height; row++) for (int col = 0; col < width; col++) {
            int pixel = (row * width + col) * 4;
            int rgba = ((pixels.get(pixel + 3) & 255) << 24) | ((pixels.get(pixel) & 255) << 16)
                | ((pixels.get(pixel + 1) & 255) << 8) | (pixels.get(pixel + 2) & 255);
            image.setRGB(col, height - row - 1, rgba);
        }
        String name = "frame-" + command.getProperty("id") + ".png";
        ImageIO.write(image, "png", agent.artifacts.resolve(name).toFile());
        agent.complete(command.getProperty("id"), true, LegacyAgent.map("artifact", name));
    }

    private void observe() {
        try {
            Class<?> minecraft = Class.forName(
                minecraftClass == null ? "net.minecraft.client.Minecraft" : minecraftClass,
                false, minecraftLoader == null ? ClassLoader.getSystemClassLoader() : minecraftLoader);
            Object client;
            try { client = minecraft.getMethod("getInstance").invoke(null); }
            catch (NoSuchMethodException old) { client = minecraft.getMethod("getMinecraft").invoke(null); }
            if (client == null) return;
            Object world = field(client, "level", "world", "theWorld");
            Object screen = field(client, "screen", "currentScreen");
            Object player = field(client, "player", "thePlayer");
            Map<String, Object> state = LegacyAgent.map("worldLoaded", world != null,
                "screen", screen == null ? "in_game" : screen.getClass().getName());
            if (player != null) {
                Object px = field(player, "x", "posX"), py = field(player, "y", "posY"), pz = field(player, "z", "posZ");
                if (px != null) state.put("x", px);
                if (py != null) state.put("y", py);
                if (pz != null) state.put("z", pz);
            }
            observation = state;
        } catch (Throwable ignored) { }
    }

    private static Object field(Object target, String... names) {
        for (String name : names) {
            try {
                Field field = target.getClass().getDeclaredField(name);
                field.setAccessible(true);
                return field.get(target);
            } catch (Throwable ignored) { }
        }
        return null;
    }

    Map<String, Object> capabilities(String target, boolean jfr) {
        return LegacyAgent.map("inputBackend", backend.equals("pending") ? "pending" : backend,
            "window", window != 0, "minecraftHooks", !observation.isEmpty(),
            "screenshot", backend.equals("pending") ? "pending" : "opengl",
            "jfr", jfr, "threads", true, "target", target);
    }

    Map<String, Object> state() {
        return LegacyAgent.map("mode", mode, "tick", frames, "lastFrame", lastFrame,
            "observation", observation);
    }
}
