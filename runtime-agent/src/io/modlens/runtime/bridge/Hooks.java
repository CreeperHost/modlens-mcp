package io.modlens.runtime.bridge;

import java.nio.ByteBuffer;

/** The only classes added to the bootstrap loader; no game or loader dependencies. */
public final class Hooks {

    public interface Handler {
        int poll(Object event);
        void client(Object client, boolean tick);
        void crash(Object report);
        void created(long window, Class<?> video);
        boolean controlled();
        boolean hidden();
        long flags(long flags);
        ByteBuffer keyboard();
        int mouse(Object x, Object y, boolean relative);
        short modifiers();
    }

    public static volatile Handler handler;

    public static int poll(Object e) {
        try {
            return handler == null ? -1 : handler.poll(e);
        } catch (Throwable t) {
            return -1;
        }
    }

    public static void client(Object c, boolean tick) {
        try {
            if (handler != null) handler.client(c, tick);
        } catch (Throwable ignored) {}
    }

    public static void crash(Object r) {
        try {
            if (handler != null) handler.crash(r);
        } catch (Throwable ignored) {}
    }

    public static void created(long w, Class<?> c) {
        try {
            if (handler != null) handler.created(w, c);
        } catch (Throwable ignored) {}
    }

    public static boolean controlled() {
        return handler != null && handler.controlled();
    }

    public static boolean hidden() {
        return handler != null && handler.hidden();
    }

    public static long flags(long f) {
        return handler == null ? f : handler.flags(f);
    }

    public static ByteBuffer keyboard() {
        return handler.keyboard();
    }

    public static int mouse(Object x, Object y, boolean r) {
        return handler.mouse(x, y, r);
    }

    public static short modifiers() {
        return handler.modifiers();
    }
}
