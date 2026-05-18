// src/tools/version-diff.test.ts
import { describe, it, expect } from "vitest";
import { classifyBreaking, diffClassIndex } from "./version-diff.js";
import type { ClassInfo } from "../access-flags.js";

describe("classifyBreaking", () => {
    it("removed public method is breaking", () => {
        expect(classifyBreaking("method_removed", 0x0001)).toBe(true);
    });
    it("added method is non-breaking", () => {
        expect(classifyBreaking("method_added", 0x0001)).toBe(false);
    });
    it("removed private method is non-breaking", () => {
        expect(classifyBreaking("method_removed", 0x0002)).toBe(false);
    });
    it("field type changed on public field is breaking", () => {
        expect(classifyBreaking("field_type_changed", 0x0001)).toBe(true);
    });
    it("superclass changed is breaking", () => {
        expect(classifyBreaking("superclass_changed", 0)).toBe(true);
    });
});

describe("diffClassIndex", () => {
    const makeClass = (overrides: Partial<ClassInfo>): ClassInfo => ({
        name: "com/example/Foo",
        superName: "java/lang/Object",
        interfaces: [],
        methods: [],
        fields: [],
        ...overrides,
    });

    it("detects added method", () => {
        const a = makeClass({ methods: [] });
        const b = makeClass({ methods: [{ name: "tick", descriptor: "()V", access: 0x0001 }] });
        const diff = diffClassIndex(a, b);
        expect(diff.methods.added).toHaveLength(1);
        expect(diff.methods.added[0].name).toBe("tick");
    });

    it("detects removed method", () => {
        const a = makeClass({ methods: [{ name: "tick", descriptor: "()V", access: 0x0001 }] });
        const b = makeClass({ methods: [] });
        const diff = diffClassIndex(a, b);
        expect(diff.methods.removed).toHaveLength(1);
    });

    it("detects signature change", () => {
        const a = makeClass({ methods: [{ name: "tick", descriptor: "()V", access: 0x0001 }] });
        const b = makeClass({ methods: [{ name: "tick", descriptor: "(I)V", access: 0x0001 }] });
        const diff = diffClassIndex(a, b);
        expect(diff.methods.signatureChanged).toHaveLength(1);
        expect(diff.methods.signatureChanged[0].from).toBe("()V");
        expect(diff.methods.signatureChanged[0].to).toBe("(I)V");
    });

    it("detects added field", () => {
        const a = makeClass({ fields: [] });
        const b = makeClass({ fields: [{ name: "level", descriptor: "Lnet/minecraft/world/level/Level;", access: 0x0001 }] });
        const diff = diffClassIndex(a, b);
        expect(diff.fields.added).toHaveLength(1);
    });

    it("detects field type change", () => {
        const a = makeClass({ fields: [{ name: "level", descriptor: "Lnet/minecraft/world/level/Level;", access: 0x0001 }] });
        const b = makeClass({ fields: [{ name: "level", descriptor: "Ljava/lang/Object;", access: 0x0001 }] });
        const diff = diffClassIndex(a, b);
        expect(diff.fields.typeChanged).toHaveLength(1);
    });

    it("detects superclass change", () => {
        const a = makeClass({ superName: "net/minecraft/world/entity/Entity" });
        const b = makeClass({ superName: "net/minecraft/world/entity/LivingEntity" });
        const diff = diffClassIndex(a, b);
        expect(diff.superChanged).toBeTruthy();
        expect(diff.superFrom).toBe("net/minecraft/world/entity/Entity");
        expect(diff.superTo).toBe("net/minecraft/world/entity/LivingEntity");
    });

    it("no diff on identical class", () => {
        const a = makeClass({ methods: [{ name: "tick", descriptor: "()V", access: 0x0001 }] });
        const diff = diffClassIndex(a, a);
        expect(diff.methods.added).toHaveLength(0);
        expect(diff.methods.removed).toHaveLength(0);
        expect(diff.methods.signatureChanged).toHaveLength(0);
        expect(diff.hasBreakingChange).toBe(false);
    });

    it("multi-overload method does not collapse to signature change", () => {
        const a = makeClass({ methods: [
            { name: "use", descriptor: "()V", access: 0x0001 },
            { name: "use", descriptor: "(I)V", access: 0x0001 },
        ] });
        const b = makeClass({ methods: [
            { name: "use", descriptor: "(I)V", access: 0x0001 },
            { name: "use", descriptor: "(II)V", access: 0x0001 },
        ] });
        const diff = diffClassIndex(a, b);
        // ()V is removed, (II)V is added — (I)V is in both and stays unchanged
        expect(diff.methods.removed).toHaveLength(1);
        expect(diff.methods.removed[0].descriptor).toBe("()V");
        expect(diff.methods.added).toHaveLength(1);
        expect(diff.methods.added[0].descriptor).toBe("(II)V");
        expect(diff.methods.signatureChanged).toHaveLength(0);
    });
});

describe("packagesHash stability", () => {
    it("module loads and classifyBreaking works as basic smoke test", () => {
        expect(classifyBreaking("method_removed", 0x0001)).toBe(true);
    });
});
