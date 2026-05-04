// ASM access flag constants
export const Opcodes = {
    ACC_PUBLIC: 0x0001,
    ACC_PRIVATE: 0x0002,
    ACC_PROTECTED: 0x0004,
    ACC_STATIC: 0x0008,
    ACC_FINAL: 0x0010,
    ACC_ABSTRACT: 0x0400,
    ACC_INTERFACE: 0x0200,
    ACC_ENUM: 0x4000,
    ACC_RECORD: 0x10000,
    ACC_ANNOTATION: 0x2000,
} as const;

export function accessStr(flags: number): string {
    if (flags & Opcodes.ACC_PUBLIC) return "public";
    if (flags & Opcodes.ACC_PROTECTED) return "protected";
    if (flags & Opcodes.ACC_PRIVATE) return "private";
    return "package-private";
}

export function descriptorToSimpleType(descriptor: string): string {
    const primitives: Record<string, string> = {
        Z: "boolean", B: "byte", C: "char", S: "short",
        I: "int", J: "long", F: "float", D: "double", V: "void",
    };
    if (descriptor.startsWith("[")) return descriptorToSimpleType(descriptor.slice(1)) + "[]";
    if (descriptor.startsWith("L")) return descriptor.slice(1, -1).split("/").pop() ?? descriptor;
    return primitives[descriptor] ?? descriptor;
}
