package io.modlens.runtime.legacy;

/** Bootstrap-visible entry points used by transformed LWJGL classes. */
public final class LegacyHooks {
    public interface Handler {
        void frame(String backend);
        void created(long window);
        int override(String owner, String method, int argument);
        Object wrapCallback(Object callback, String method);
        boolean controlled();
        boolean hidden();
        void crash(Object report);
    }

    public static volatile Handler handler;

    public static void frame(String backend) {
        try { if (handler != null) handler.frame(backend); } catch (Throwable ignored) { }
    }

    public static void created(long window) {
        try { if (handler != null) handler.created(window); } catch (Throwable ignored) { }
    }

    public static int override(String owner, String method, int argument) {
        try { return handler == null ? Integer.MIN_VALUE : handler.override(owner, method, argument); }
        catch (Throwable ignored) { return Integer.MIN_VALUE; }
    }

    public static Object wrapCallback(Object callback, String method) {
        try { return handler == null ? callback : handler.wrapCallback(callback, method); }
        catch (Throwable ignored) { return callback; }
    }

    public static boolean controlled() {
        return handler != null && handler.controlled();
    }

    public static boolean hidden() {
        return handler != null && handler.hidden();
    }

    public static void crash(Object report) {
        try { if (handler != null) handler.crash(report); } catch (Throwable ignored) { }
    }
}
