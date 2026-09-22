package io.modlens.runtime;

import java.util.*;
import java.util.function.Consumer;

/** Optional 26.3 API adapter. Failure here must not disable SDL input or JVM diagnostics. */
final class Minecraft263 {

    private final RuntimeAgent agent;
    volatile Object client;
    volatile Map<String, Object> observation = Map.of();
    volatile String screenshotCapability = "pending Minecraft render hook";
    private long lastObserved;

    Minecraft263(RuntimeAgent agent) {
        this.agent = agent;
    }

    void observe(Object instance) {
        client = instance;
        long now = System.currentTimeMillis();
        if (now - lastObserved < 1000) return;
        lastObserved = now;
        var info = new LinkedHashMap<String, Object>();
        try {
            Object screen = Reflect.call(Reflect.field(instance, "gui"), "screen");
            info.put("screen", screen == null ? "in_game" : screen.getClass().getName());
            info.put("worldLoaded", Reflect.field(instance, "level") != null);
            info.put("gameLoaded", Reflect.call(instance, "isGameLoadFinished"));
            Object player = Reflect.field(instance, "player");
            if (player != null) {
                info.put("x", Reflect.call(player, "getX"));
                info.put("y", Reflect.call(player, "getY"));
                info.put("z", Reflect.call(player, "getZ"));
            }
        } catch (Exception e) {
            info.put("stateUnavailable", e.toString());
        }
        // Probe each capability independently: an optional state accessor must not
        // disable screenshot support, and neither is required for SDL control.
        try {
            var loader = instance.getClass().getClassLoader();
            Class.forName("net.minecraft.client.Screenshot", false, loader).getMethod(
                "takeScreenshot",
                Class.forName("com.mojang.blaze3d.pipeline.RenderTarget", false, loader),
                Consumer.class
            );
            screenshotCapability = "minecraft";
        } catch (Exception e) {
            screenshotCapability = "unavailable: " + e;
        }
        observation = info;
    }

    void screenshot(Properties c) throws Exception {
        if (client == null) throw new IllegalStateException(
            "Minecraft screenshot hook unavailable; SDL input and JVM monitoring remain available"
        );
        if (!((Boolean) Reflect.call(client, "isGameLoadFinished"))) throw new IllegalStateException(
            "Minecraft is still loading graphics resources; retry screenshot after state.observation.gameLoaded is true"
        );
        Object target = Reflect.call(Reflect.field(client, "gameRenderer"), "mainRenderTarget");
        Class<?> screenshot = Class.forName(
            "net.minecraft.client.Screenshot",
            false,
            client.getClass().getClassLoader()
        );
        Consumer<Object> done = image ->
            agent.async(() -> {
                String name = "frame-" + c.getProperty("id") + ".png";
                try {
                    Reflect.call(image, "writeToFile", agent.artifacts.resolve(name));
                    agent.complete(c, true, Map.of("artifact", name));
                } catch (Exception e) {
                    agent.complete(c, false, Map.of("error", e.toString()));
                } finally {
                    try {
                        Reflect.call(image, "close");
                    } catch (Exception ignored) {}
                }
            });
        Reflect.call(screenshot, "takeScreenshot", target, done);
    }

    void crash(Object report) {
        try {
            agent.failure("minecraft_crash", "client", (Throwable) Reflect.call(report, "getException"));
        } catch (Exception e) {
            agent.event("minecraft_crash", Map.of("report", report.toString()));
        }
    }
}
