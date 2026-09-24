package org.lwjgl.opengl;

import java.nio.ByteBuffer;

public final class GL11 {
    public static void glReadPixels(int x, int y, int width, int height, int format, int type, ByteBuffer output) {
        for (int i = 0; i < width * height; i++) {
            output.put(i * 4, (byte) 255);
            output.put(i * 4 + 1, (byte) 0);
            output.put(i * 4 + 2, (byte) 0);
            output.put(i * 4 + 3, (byte) 255);
        }
    }
}
