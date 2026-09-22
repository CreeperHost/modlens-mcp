package io.modlens.runtime;

import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

final class Reflect {

    private static final Map<String, Method> METHODS = new ConcurrentHashMap<>();

    static Object call(Object target, String name, Object... args) throws Exception {
        Class<?> cls = target instanceof Class<?> c ? c : target.getClass();
        String key =
            cls.getName() +
            "@" +
            System.identityHashCode(cls.getClassLoader()) +
            "#" +
            name +
            Arrays.toString(
                Arrays.stream(args)
                    .map(a -> a == null ? null : a.getClass())
                    .toArray()
            );
        Method m = METHODS.get(key);
        if (m == null) {
            outer: for (Method candidate : cls.getMethods()) {
                if (
                    !candidate.getName().equals(name) || candidate.getParameterCount() != args.length
                ) continue;
                Class<?>[] types = candidate.getParameterTypes();
                for (int i = 0; i < types.length; i++) if (
                    args[i] != null && !boxed(types[i]).isInstance(args[i])
                ) continue outer;
                m = candidate;
                METHODS.put(key, m);
                break;
            }
        }
        if (m == null) throw new NoSuchMethodException(cls.getName() + "." + name);
        return m.invoke(target instanceof Class<?> ? null : target, args);
    }

    static Object field(Object target, String name) throws Exception {
        return target.getClass().getField(name).get(target);
    }

    private static Class<?> boxed(Class<?> t) {
        if (!t.isPrimitive()) return t;
        return switch (t.getName()) {
            case "int" -> Integer.class;
            case "long" -> Long.class;
            case "float" -> Float.class;
            case "double" -> Double.class;
            case "short" -> Short.class;
            case "byte" -> Byte.class;
            case "boolean" -> Boolean.class;
            case "char" -> Character.class;
            default -> t;
        };
    }
}
