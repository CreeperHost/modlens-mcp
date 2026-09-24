package io.modlens.runtime.legacy;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;
import java.util.*;
import org.objectweb.asm.*;

/** Hooks stable LWJGL entry points instead of Minecraft method names. */
final class LegacyTransformer implements ClassFileTransformer, Opcodes {
    private static final String HOOKS = "io/modlens/runtime/legacy/LegacyHooks";
    private static final Set<String> TARGETS = new HashSet<String>(Arrays.asList(
        "org/lwjgl/input/Keyboard", "org/lwjgl/input/Mouse", "org/lwjgl/opengl/Display",
        "org/lwjgl/glfw/GLFW", "net/minecraft/CrashReport", "net/minecraft/crash/CrashReport",
        "net/minecraft/client/Minecraft", "net/minecraft/client/MinecraftClient"));
    private static final Set<String> INPUT_CALLBACKS = new HashSet<String>(Arrays.asList(
        "glfwSetKeyCallback", "glfwSetCharCallback", "glfwSetCharModsCallback",
        "glfwSetMouseButtonCallback", "glfwSetCursorPosCallback", "glfwSetScrollCallback"));
    private final LegacyAgent agent;

    LegacyTransformer(LegacyAgent agent) { this.agent = agent; }

    public byte[] transform(final ClassLoader loader, final String name, Class<?> original,
            ProtectionDomain protection, byte[] bytes) {
        if (name == null || !TARGETS.contains(name)) return null;
        if (name.equals("net/minecraft/client/Minecraft") || name.equals("net/minecraft/client/MinecraftClient")) {
            agent.input.minecraftLoader(loader, name.replace('/', '.'));
            return null;
        }
        try {
            ClassReader reader = new ClassReader(bytes);
            ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS) {
                protected String getCommonSuperClass(String left, String right) {
                    try {
                        ClassLoader target = loader == null ? ClassLoader.getSystemClassLoader() : loader;
                        Class<?> a = Class.forName(left.replace('/', '.'), false, target);
                        Class<?> b = Class.forName(right.replace('/', '.'), false, target);
                        if (a.isAssignableFrom(b)) return left;
                        if (b.isAssignableFrom(a)) return right;
                        if (a.isInterface() || b.isInterface()) return "java/lang/Object";
                        do { a = a.getSuperclass(); } while (a != null && !a.isAssignableFrom(b));
                        return a == null ? "java/lang/Object" : Type.getInternalName(a);
                    } catch (Throwable ignored) { return "java/lang/Object"; }
                }
            };
            final List<String> installed = new ArrayList<String>();
            reader.accept(new ClassVisitor(ASM9, writer) {
                public MethodVisitor visitMethod(int access, final String method, final String descriptor,
                        String signature, String[] exceptions) {
                    MethodVisitor output = super.visitMethod(access, method, descriptor, signature, exceptions);
                    if (output == null || (access & (ACC_ABSTRACT | ACC_NATIVE)) != 0) return output;
                    final boolean glfw = name.equals("org/lwjgl/glfw/GLFW");
                    final boolean display = name.equals("org/lwjgl/opengl/Display");
                    final boolean crash = name.equals("net/minecraft/CrashReport") ||
                        name.equals("net/minecraft/crash/CrashReport");
                    final boolean input = name.equals("org/lwjgl/input/Keyboard") || name.equals("org/lwjgl/input/Mouse");
                    final Type returnType = Type.getReturnType(descriptor);
                    final boolean inputMethod = input && (returnType.getSort() == Type.BOOLEAN ||
                        returnType.getSort() == Type.INT || returnType.getSort() == Type.CHAR) &&
                        (method.equals("next") || method.startsWith("getEvent") || method.equals("isKeyDown") ||
                            method.equals("isButtonDown") || method.equals("getX") || method.equals("getY") ||
                            method.equals("getDX") || method.equals("getDY") || method.equals("getDWheel"));
                    final boolean glfwPoll = glfw && descriptor.equals("(JI)I") &&
                        (method.equals("glfwGetKey") || method.equals("glfwGetMouseButton"));
                    final boolean frame = (display && method.equals("update")) ||
                        (glfw && (method.equals("glfwPollEvents") || method.equals("glfwWaitEvents") ||
                            method.equals("glfwWaitEventsTimeout")));
                    final boolean create = (display && method.equals("create") && returnType.getSort() == Type.VOID) ||
                        (glfw && method.equals("glfwCreateWindow") && returnType.getSort() == Type.LONG);
                    final Type[] args = Type.getArgumentTypes(descriptor);
                    final boolean callback = glfw && INPUT_CALLBACKS.contains(method) &&
                        args.length == 2 && args[0].getSort() == Type.LONG && args[1].getSort() == Type.OBJECT &&
                        args[1].getInternalName().startsWith("org/lwjgl/glfw/GLFW") &&
                        args[1].getInternalName().endsWith("CallbackI");
                    final boolean suppress = glfw && descriptor.equals("(J)V") &&
                        (method.equals("glfwShowWindow") || method.equals("glfwFocusWindow"));
                    final boolean active = display && method.equals("isActive") && descriptor.equals("()Z");
                    final boolean crashConstructor = crash && method.equals("<init>") && descriptor.contains("Ljava/lang/Throwable;");
                    if (!(inputMethod || glfwPoll || frame || create || callback || suppress || active || crashConstructor)) return output;
                    installed.add(method + descriptor);
                    return new MethodVisitor(ASM9, output) {
                        public void visitCode() {
                            super.visitCode();
                            if (inputMethod || glfwPoll) {
                                super.visitLdcInsn(name.substring(name.lastIndexOf('/') + 1));
                                super.visitLdcInsn(method);
                                if (glfwPoll) super.visitVarInsn(ILOAD, 2);
                                else if ((method.equals("isKeyDown") || method.equals("isButtonDown")) && args.length == 1)
                                    super.visitVarInsn(ILOAD, 0);
                                else super.visitInsn(ICONST_0);
                                super.visitMethodInsn(INVOKESTATIC, HOOKS, "override",
                                    "(Ljava/lang/String;Ljava/lang/String;I)I", false);
                                super.visitInsn(DUP);
                                super.visitLdcInsn(Integer.MIN_VALUE);
                                Label original = new Label();
                                super.visitJumpInsn(IF_ICMPEQ, original);
                                super.visitInsn(IRETURN);
                                super.visitLabel(original);
                                super.visitInsn(POP);
                            }
                            if (frame) {
                                super.visitLdcInsn(glfw ? "glfw" : "lwjgl2");
                                super.visitMethodInsn(INVOKESTATIC, HOOKS, "frame", "(Ljava/lang/String;)V", false);
                            }
                            if (callback) {
                                super.visitVarInsn(ALOAD, 2);
                                super.visitLdcInsn(method);
                                super.visitMethodInsn(INVOKESTATIC, HOOKS, "wrapCallback",
                                    "(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/Object;", false);
                                super.visitTypeInsn(CHECKCAST, args[1].getInternalName());
                                super.visitVarInsn(ASTORE, 2);
                            }
                            if (suppress || active) {
                                super.visitMethodInsn(INVOKESTATIC, HOOKS,
                                    method.equals("glfwShowWindow") ? "hidden" : "controlled", "()Z", false);
                                Label proceed = new Label();
                                super.visitJumpInsn(IFEQ, proceed);
                                if (active) super.visitInsn(ICONST_1);
                                super.visitInsn(active ? IRETURN : RETURN);
                                super.visitLabel(proceed);
                            }
                        }

                        public void visitInsn(int opcode) {
                            if (crashConstructor && opcode == RETURN) {
                                super.visitVarInsn(ALOAD, 0);
                                super.visitMethodInsn(INVOKESTATIC, HOOKS, "crash", "(Ljava/lang/Object;)V", false);
                            }
                            if (create && glfw && opcode == LRETURN) {
                                super.visitInsn(DUP2);
                                super.visitMethodInsn(INVOKESTATIC, HOOKS, "created", "(J)V", false);
                            }
                            if (create && display && opcode == RETURN) {
                                super.visitInsn(LCONST_1);
                                super.visitMethodInsn(INVOKESTATIC, HOOKS, "created", "(J)V", false);
                            }
                            super.visitInsn(opcode);
                        }
                    };
                }
            }, ClassReader.EXPAND_FRAMES);
            if (installed.isEmpty()) return null;
            agent.event("hooks_installed", LegacyAgent.map("class", name, "methods", installed));
            return writer.toByteArray();
        } catch (Throwable error) {
            agent.event("hook_unavailable", LegacyAgent.map("class", name, "reason", error.toString()));
            return null;
        }
    }
}
