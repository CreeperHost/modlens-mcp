package io.modlens.runtime;

import java.util.*;

/** Output only: incoming commands use java.util.Properties, never a custom JSON parser. */
final class Json {

    static String encode(Object value) {
        if (value == null) return "null";
        if (value instanceof Boolean) return value.toString();
        if (value instanceof Number n) return Double.isFinite(n.doubleValue()) ? n.toString() : "null";
        if (value instanceof Map<?, ?> map) {
            var parts = new ArrayList<String>();
            map.forEach((k, v) -> parts.add(encode(k.toString()) + ":" + encode(v)));
            return "{" + String.join(",", parts) + "}";
        }
        if (value instanceof Iterable<?> list) {
            var parts = new ArrayList<String>();
            list.forEach(v -> parts.add(encode(v)));
            return "[" + String.join(",", parts) + "]";
        }
        String s = value.toString();
        var out = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32 || Character.isSurrogate(c)) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
}
