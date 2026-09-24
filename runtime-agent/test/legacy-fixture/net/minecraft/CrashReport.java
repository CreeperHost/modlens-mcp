package net.minecraft;

public final class CrashReport {
    private final Throwable cause;
    public CrashReport(Throwable cause) { this.cause = cause; }
    public String toString() { return "Synthetic Minecraft crash: " + cause; }
}
