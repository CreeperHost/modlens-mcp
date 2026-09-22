package io.modlens.runtime;

import io.modlens.runtime.bridge.Hooks;
import java.lang.classfile.*;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.*;
import java.lang.instrument.*;
import java.security.ProtectionDomain;
import java.util.*;
import java.util.function.Consumer;

/** 26.3 uses SDL3. Exact signatures are the compatibility contract, not line numbers. */
final class Transformer implements ClassFileTransformer {

    private static final ClassDesc HOOKS = ClassDesc.of("io.modlens.runtime.bridge.Hooks");
    private final Instrumentation instrumentation;
    private final RuntimeAgent agent;
    private final boolean minecraftHooks;

    Transformer(Instrumentation instrumentation, RuntimeAgent agent, boolean minecraftHooks) {
        this.instrumentation = instrumentation;
        this.agent = agent;
        this.minecraftHooks = minecraftHooks;
    }

    private static void call(CodeBuilder b, String name, String type) {
        b.invokestatic(HOOKS, name, MethodTypeDesc.ofDescriptor(type));
    }

    @Override
    public byte[] transform(
        Module module,
        ClassLoader loader,
        String name,
        Class<?> old,
        ProtectionDomain domain,
        byte[] bytes
    ) {
        boolean sdl = Set.of(
            "org/lwjgl/sdl/SDLEvents",
            "org/lwjgl/sdl/SDLVideo",
            "org/lwjgl/sdl/SDLKeyboard",
            "org/lwjgl/sdl/SDLMouse"
        ).contains(name);
        boolean mc = minecraftHooks && name.equals("net/minecraft/client/Minecraft");
        if (!sdl && !mc) return null;
        try {
            if (module.isNamed()) instrumentation.redefineModule(
                module,
                Set.of(Hooks.class.getModule()),
                Map.of(),
                Map.of(),
                Set.of(),
                Map.of()
            );
            var cf = ClassFile.of(
                ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader))
            );
            var model = cf.parse(bytes);
            List<String> installed = new ArrayList<>();
            byte[] result = cf.transformClass(model, (builder, element) -> {
                if (!(element instanceof MethodModel m) || m.code().isEmpty()) {
                    builder.with(element);
                    return;
                }
                String n = m.methodName().stringValue(),
                    d = m.methodType().stringValue();
                Consumer<CodeBuilder> enter = null,
                    leave = null;
                if (sdl) {
                    if (n.equals("SDL_PollEvent") && d.equals("(Lorg/lwjgl/sdl/SDL_Event;)Z")) enter = b -> {
                        b.aload(0);
                        call(b, "poll", "(Ljava/lang/Object;)I");
                        b.istore(1).iload(1).iconst_m1();
                        b.ifThen(Opcode.IF_ICMPNE, t -> t.iload(1).ireturn());
                    };
                    if (
                        n.equals("SDL_CreateWindow") &&
                        (d.equals("(Ljava/lang/CharSequence;IIJ)J") ||
                            d.equals("(Ljava/nio/ByteBuffer;IIJ)J"))
                    ) {
                        enter = b -> {
                            call(b, "hidden", "()Z");
                            b.ifThen(t ->
                                t.lload(3).loadConstant(8L).lor().loadConstant(~1L).land().lstore(3)
                            );
                        };
                        leave = b -> {
                            b.dup2().ldc(ClassDesc.of("org.lwjgl.sdl.SDLVideo"));
                            call(b, "created", "(JLjava/lang/Class;)V");
                        };
                    }
                    if (n.equals("SDL_CreateWindowWithProperties") && d.equals("(I)J")) leave = b -> {
                        b.dup2().ldc(ClassDesc.of("org.lwjgl.sdl.SDLVideo"));
                        call(b, "created", "(JLjava/lang/Class;)V");
                    };
                    if (n.equals("SDL_ShowWindow") && d.equals("(J)Z")) enter = b -> {
                        call(b, "hidden", "()Z");
                        b.ifThen(t -> t.iconst_1().ireturn());
                    };
                    if (n.equals("SDL_GetWindowFlags") && d.equals("(J)J")) leave = b ->
                        call(b, "flags", "(J)J");
                    if (
                        (n.equals("SDL_RaiseWindow") && d.equals("(J)Z")) ||
                        (Set.of(
                            "SDL_SetWindowRelativeMouseMode",
                            "SDL_SetWindowKeyboardGrab",
                            "SDL_SetWindowMouseGrab",
                            "SDL_SetWindowFullscreen"
                        ).contains(n) &&
                            d.equals("(JZ)Z"))
                    ) enter = b -> {
                        call(b, "controlled", "()Z");
                        b.ifThen(t -> t.iconst_1().ireturn());
                    };
                    if (n.equals("SDL_WarpMouseInWindow") && d.equals("(JFF)V")) enter = b -> {
                        call(b, "controlled", "()Z");
                        b.ifThen(t -> t.return_());
                    };
                    if (n.equals("SDL_GetKeyboardState") && d.equals("()Ljava/nio/ByteBuffer;")) enter =
                        b -> {
                            call(b, "controlled", "()Z");
                            b.ifThen(t -> {
                                call(t, "keyboard", "()Ljava/nio/ByteBuffer;");
                                t.areturn();
                            });
                        };
                    if (n.equals("SDL_GetModState") && d.equals("()S")) enter = b -> {
                        call(b, "controlled", "()Z");
                        b.ifThen(t -> {
                            call(t, "modifiers", "()S");
                            t.ireturn();
                        });
                    };
                    if (
                        (n.equals("SDL_GetMouseState") || n.equals("SDL_GetRelativeMouseState")) &&
                        d.equals("(Ljava/nio/FloatBuffer;Ljava/nio/FloatBuffer;)I")
                    ) {
                        boolean relative = n.contains("Relative");
                        enter = b -> {
                            call(b, "controlled", "()Z");
                            b.ifThen(t -> {
                                t.aload(0)
                                    .aload(1)
                                    .loadConstant(relative ? 1 : 0);
                                call(t, "mouse", "(Ljava/lang/Object;Ljava/lang/Object;Z)I");
                                t.ireturn();
                            });
                        };
                    }
                } else {
                    if (n.equals("runTick") && d.equals("(Z)V")) leave = b -> {
                        b.aload(0).iconst_0();
                        call(b, "client", "(Ljava/lang/Object;Z)V");
                    };
                    if (n.equals("tick") && d.equals("()V")) enter = b -> {
                        b.aload(0).iconst_1();
                        call(b, "client", "(Ljava/lang/Object;Z)V");
                    };
                    if (n.equals("isWindowActive") && d.equals("()Z")) enter = b -> {
                        call(b, "controlled", "()Z");
                        b.ifThen(t -> t.iconst_1().ireturn());
                    };
                    if (
                        n.equals("crash") &&
                        d.equals(
                            "(Lnet/minecraft/client/Minecraft;Ljava/io/File;Lnet/minecraft/CrashReport;I)V"
                        )
                    ) enter = b -> {
                        b.aload(2);
                        call(b, "crash", "(Ljava/lang/Object;)V");
                    };
                }
                if (enter == null && leave == null) {
                    builder.with(element);
                    return;
                }
                installed.add(n + d);
                Consumer<CodeBuilder> before = enter,
                    after = leave;
                builder.transformMethod(
                    m,
                    MethodTransform.transformingCode(
                        new CodeTransform() {
                            @Override
                            public void atStart(CodeBuilder b) {
                                if (before != null) before.accept(b);
                            }

                            @Override
                            public void accept(CodeBuilder b, CodeElement e) {
                                if (after != null && e instanceof ReturnInstruction) after.accept(b);
                                b.with(e);
                            }
                        }
                    )
                );
            });
            agent.event("hooks_installed", Map.of("class", name, "methods", installed));
            return installed.isEmpty() ? null : result;
        } catch (Throwable e) {
            agent.event("hook_unavailable", Map.of("class", name, "reason", e.toString()));
            return null;
        }
    }
}
