package org.lwjgl.input;

public final class Keyboard {
    public static boolean next() { return false; }
    public static int getEventKey() { return -1; }
    public static char getEventCharacter() { return 0; }
    public static boolean getEventKeyState() { return false; }
    public static boolean isKeyDown(int key) { return false; }
    public static int getKeyIndex(String key) { return key.equals("W") ? 17 : key.equals("SPACE") ? 57 : 0; }
}
