# access-flags formatClassMembers Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `src/access-flags.test.ts` with tests for `formatClassMembers`. The function is a pure transformer — it takes a `ClassInfo` object and returns a shaped output with method/field metadata, AT strings, mixin targets, and shadow annotations. No I/O or mocks needed.

**Existing coverage** (already in `access-flags.test.ts`): `accessStr` (7 tests) and `descriptorToSimpleType` (5 tests). `formatClassMembers` and the `ClassInfo` interface are exported but have zero tests.

**Architecture:** Append `describe("formatClassMembers", ...)` blocks to the existing test file. Use a shared `ClassInfo` fixture covering realistic flag combinations (public static final field, public abstract method, private instance method, etc.).

**Tech Stack:** Vitest — no mocks, no I/O.

---

## File Map

- **Append to:** `src/access-flags.test.ts`
- **Read (do not modify):** `src/access-flags.ts`

---

## Task 1: Class-level output

- [ ] **Step 1: Add import for `formatClassMembers` and `ClassInfo` at the top of the test file**

  Change the existing import line:
  ```typescript
  import { accessStr, descriptorToSimpleType, Opcodes } from "./access-flags.js";
  ```
  to:
  ```typescript
  import { accessStr, descriptorToSimpleType, formatClassMembers, Opcodes } from "./access-flags.js";
  import type { ClassInfo } from "./access-flags.js";
  ```

- [ ] **Step 2: Write failing test — class-level properties**

  Append to `src/access-flags.test.ts`:
  ```typescript
  // ── Shared fixture ─────────────────────────────────────────────────────────
  const FIXTURE: ClassInfo = {
      name: "net/minecraft/world/World",
      superName: "net/minecraft/world/level/Level",
      interfaces: ["net/minecraft/world/IWorld"],
      methods: [
          { name: "tick",   descriptor: "(Ljava/util/function/BooleanSupplier;)V", access: Opcodes.ACC_PUBLIC },
          { name: "method_1234", descriptor: "()V", access: Opcodes.ACC_PUBLIC | Opcodes.ACC_ABSTRACT },
          { name: "privateHelper", descriptor: "(I)Z", access: Opcodes.ACC_PRIVATE },
          { name: "staticFactory", descriptor: "()Lnet/minecraft/world/World;", access: Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC },
      ],
      fields: [
          { name: "random",    descriptor: "Ljava/util/Random;",  access: Opcodes.ACC_PUBLIC },
          { name: "CONSTANT",  descriptor: "I",                   access: Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC | Opcodes.ACC_FINAL },
          { name: "dimension", descriptor: "Lnet/minecraft/world/dimension/DimensionType;", access: Opcodes.ACC_PRIVATE | Opcodes.ACC_FINAL },
      ],
  };

  describe("formatClassMembers — class-level output", () => {
      it("echoes className and superClass", () => {
          const out = formatClassMembers(FIXTURE);
          expect(out.className).toBe("net/minecraft/world/World");
          expect(out.superClass).toBe("net/minecraft/world/level/Level");
      });

      it("echoes interfaces array", () => {
          const out = formatClassMembers(FIXTURE);
          expect(out.interfaces).toEqual(["net/minecraft/world/IWorld"]);
      });

      it("produces correct AT strings for class access/extendability", () => {
          const out = formatClassMembers(FIXTURE);
          expect(out.atStrings.accessible).toBe("accessible class net/minecraft/world/World");
          expect(out.atStrings.extendable).toBe("extendable class net/minecraft/world/World");
      });
  });
  ```

- [ ] **Step 3: Run to verify 3 tests pass**

  ```powershell
  npx vitest run src/access-flags.test.ts
  ```
  Expected: PASS (15 total — 12 existing + 3 new).

- [ ] **Step 4: Commit**

  ```powershell
  git add src/access-flags.test.ts
  git commit -m "test: formatClassMembers class-level output"
  ```

---

## Task 2: Method metadata

- [ ] **Step 1: Write failing method tests**

  Append to `src/access-flags.test.ts`:
  ```typescript
  describe("formatClassMembers — methods", () => {
      let methods: ReturnType<typeof formatClassMembers>["methods"];
      beforeAll(() => { methods = formatClassMembers(FIXTURE).methods; });

      it("returns one entry per method", () => {
          expect(methods).toHaveLength(4);
      });

      it("echoes name and descriptor", () => {
          expect(methods[0].name).toBe("tick");
          expect(methods[0].descriptor).toBe("(Ljava/util/function/BooleanSupplier;)V");
      });

      it("resolves access string via accessStr", () => {
          expect(methods[0].access).toBe("public");
          expect(methods[2].access).toBe("private");
      });

      it("detects isStatic correctly", () => {
          expect(methods[0].isStatic).toBe(false);  // tick
          expect(methods[3].isStatic).toBe(true);   // staticFactory
      });

      it("detects isFinal correctly", () => {
          expect(methods[0].isFinal).toBe(false);
          // none of the fixture methods are final
          expect(methods.every((m) => !m.isFinal)).toBe(true);
      });

      it("detects isAbstract correctly", () => {
          expect(methods[1].isAbstract).toBe(true);  // method_1234
          expect(methods[0].isAbstract).toBe(false); // tick
      });

      it("produces mixinTarget as name+descriptor", () => {
          expect(methods[0].mixinTarget).toBe("tick(Ljava/util/function/BooleanSupplier;)V");
      });

      it("produces AT string in correct format", () => {
          expect(methods[0].atString).toBe(
              "accessible method net/minecraft/world/World tick (Ljava/util/function/BooleanSupplier;)V",
          );
      });
  });
  ```

  Add `beforeAll` to the import at the top of the file:
  ```typescript
  import { describe, it, expect, beforeAll } from "vitest";
  ```

- [ ] **Step 2: Run to verify 8 new tests pass**

  ```powershell
  npx vitest run src/access-flags.test.ts
  ```
  Expected: PASS (23 total).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/access-flags.test.ts
  git commit -m "test: formatClassMembers method metadata"
  ```

---

## Task 3: Field metadata

- [ ] **Step 1: Write failing field tests**

  Append to `src/access-flags.test.ts`:
  ```typescript
  describe("formatClassMembers — fields", () => {
      let fields: ReturnType<typeof formatClassMembers>["fields"];
      beforeAll(() => { fields = formatClassMembers(FIXTURE).fields; });

      it("returns one entry per field", () => {
          expect(fields).toHaveLength(3);
      });

      it("echoes name and descriptor", () => {
          expect(fields[0].name).toBe("random");
          expect(fields[0].descriptor).toBe("Ljava/util/Random;");
      });

      it("resolves access string", () => {
          expect(fields[0].access).toBe("public");
          expect(fields[2].access).toBe("private");
      });

      it("detects isStatic — CONSTANT is static, others are not", () => {
          expect(fields[0].isStatic).toBe(false); // random
          expect(fields[1].isStatic).toBe(true);  // CONSTANT
          expect(fields[2].isStatic).toBe(false); // dimension
      });

      it("detects isFinal — CONSTANT and dimension are final", () => {
          expect(fields[0].isFinal).toBe(false); // random
          expect(fields[1].isFinal).toBe(true);  // CONSTANT
          expect(fields[2].isFinal).toBe(true);  // dimension
      });

      it("shadowAnnotation uses accessStr + static keyword when static", () => {
          // CONSTANT: public static int CONSTANT
          expect(fields[1].shadowAnnotation).toBe("@Shadow public static int CONSTANT;");
      });

      it("shadowAnnotation omits 'static' for instance fields", () => {
          // random: public Random random (note: simple type from descriptor)
          expect(fields[0].shadowAnnotation).toBe("@Shadow public Random random;");
      });

      it("uses 'mutable' AT prefix for final fields", () => {
          // CONSTANT is final → mutable
          expect(fields[1].atString).toBe("mutable field net/minecraft/world/World CONSTANT I");
          // dimension is final → mutable
          expect(fields[2].atString).toContain("mutable field net/minecraft/world/World dimension");
      });

      it("uses 'accessible' AT prefix for non-final fields", () => {
          // random is not final → accessible
          expect(fields[0].atString).toBe(
              "accessible field net/minecraft/world/World random Ljava/util/Random;",
          );
      });
  });
  ```

- [ ] **Step 2: Run to verify 9 new tests pass**

  ```powershell
  npx vitest run src/access-flags.test.ts
  ```
  Expected: PASS (32 total).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/access-flags.test.ts
  git commit -m "test: formatClassMembers field metadata"
  ```

---

## Task 4: Edge cases

- [ ] **Step 1: Write failing edge case tests**

  Append to `src/access-flags.test.ts`:
  ```typescript
  describe("formatClassMembers — edge cases", () => {
      it("handles ClassInfo with no methods or fields", () => {
          const empty: ClassInfo = {
              name: "net/minecraft/A",
              superName: "java/lang/Object",
              interfaces: [],
              methods: [],
              fields: [],
          };
          const out = formatClassMembers(empty);
          expect(out.methods).toEqual([]);
          expect(out.fields).toEqual([]);
          expect(out.atStrings.accessible).toBe("accessible class net/minecraft/A");
      });

      it("handles ClassInfo with empty interfaces array", () => {
          const info: ClassInfo = {
              name: "net/minecraft/A",
              superName: "java/lang/Object",
              interfaces: [],
              methods: [],
              fields: [],
          };
          expect(formatClassMembers(info).interfaces).toEqual([]);
      });

      it("is deterministic — same input always returns equal output", () => {
          const a = formatClassMembers(FIXTURE);
          const b = formatClassMembers(FIXTURE);
          expect(a).toEqual(b);
      });
  });
  ```

- [ ] **Step 2: Run to verify 3 new tests pass**

  ```powershell
  npx vitest run src/access-flags.test.ts
  ```
  Expected: PASS (35 total).

- [ ] **Step 3: Run full test suite**

  ```powershell
  npm test
  ```
  Expected: all existing tests pass + 23 new access-flags tests.

- [ ] **Step 4: Commit**

  ```powershell
  git add src/access-flags.test.ts
  git commit -m "test: formatClassMembers edge cases and full suite passing"
  ```
