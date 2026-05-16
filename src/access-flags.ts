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

// ── Class member formatting (shared by mod and vanilla tools) ─────────────────

export interface ClassInfo {
    name: string;
    superName: string;
    interfaces: string[];
    methods: Array<{ name: string; descriptor: string; access: number }>;
    fields: Array<{ name: string; descriptor: string; access: number }>;
}

export function formatClassMembers(info: ClassInfo) {
    const methods = info.methods.map((m) => {
        const access = accessStr(m.access);
        const isStatic = !!(m.access & Opcodes.ACC_STATIC);
        const isFinal = !!(m.access & Opcodes.ACC_FINAL);
        const isAbstract = !!(m.access & Opcodes.ACC_ABSTRACT);
        return {
            name: m.name,
            descriptor: m.descriptor,
            access,
            isStatic,
            isFinal,
            isAbstract,
            mixinTarget: `${m.name}${m.descriptor}`,
            atString: `accessible method ${info.name} ${m.name} ${m.descriptor}`,
        };
    });

    const fields = info.fields.map((f) => {
        const access = accessStr(f.access);
        const isStatic = !!(f.access & Opcodes.ACC_STATIC);
        const isFinal = !!(f.access & Opcodes.ACC_FINAL);
        const javaType = descriptorToSimpleType(f.descriptor);
        const atPrefix = isFinal ? "mutable" : "accessible";
        return {
            name: f.name,
            descriptor: f.descriptor,
            access,
            isStatic,
            isFinal,
            shadowAnnotation: `@Shadow ${access}${isStatic ? " static" : ""} ${javaType} ${f.name};`,
            atString: `${atPrefix} field ${info.name} ${f.name} ${f.descriptor}`,
        };
    });

    return {
        className: info.name,
        superClass: info.superName,
        interfaces: info.interfaces,
        atStrings: {
            accessible: `accessible class ${info.name}`,
            extendable: `extendable class ${info.name}`,
        },
        methods,
        fields,
    };
}
